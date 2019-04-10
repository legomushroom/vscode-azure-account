/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const CacheDriver = require('adal-node/lib/cache-driver');
const createLogContext = require('adal-node/lib/log').createLogContext;

import { MemoryCache, AuthenticationContext, Logging } from 'adal-node';
import * as nls from 'vscode-nls';
import * as keytarType from 'keytar';
import * as http from 'http';
import * as https from 'https';

import { window, commands, EventEmitter, MessageItem, ExtensionContext, workspace, env, OutputChannel, CancellationTokenSource, Uri } from 'vscode';
import { VSCodeAccount, ISession, VSCodeLoginStatus, Token, IEnvironment } from './vscode-account.api';
import * as codeFlowLogin from './codeFlowLogin';
import TelemetryReporter from 'vscode-extension-telemetry';
import { TokenResponse } from 'adal-node';

const localize = nls.loadMessageBundle();

const keytarModule = getNodeModule<typeof keytarType>('keytar');

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;
function getNodeModule<T>(moduleName: string): T | undefined {
	const r = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
	
	try {
		return r(`${env.appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}

	try {
		return r(`${env.appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

const credentialsSection = 'VS Code Account';

async function getRefreshToken(environment: IEnvironment, migrateToken?: boolean, keytar?: typeof keytarType) {
	if (!keytar) {
		return;
	}
	const tokenKey = `${environment}_vscode-account`;

	try {
		if (migrateToken) {
			const token = await keytar.getPassword(tokenKey, 'Refresh Token');
			if (token) {
				if (!await keytar.getPassword(credentialsSection, environment.name)) {
					await keytar.setPassword(credentialsSection, environment.name, token);
				}
				await keytar.deletePassword(tokenKey, 'Refresh Token');
			}
		}
	} catch (err) {
		// ignore
	}
	try {
		return keytar.getPassword(credentialsSection, environment.name);
	} catch (err) {
		// ignore
	}
}

async function storeRefreshToken(environment: IEnvironment, token: string, keytar?: typeof keytarType) {
	if (keytar) {
		try {
			await keytar.setPassword(credentialsSection, environment.name, token);
		} catch (err) {
			// ignore
		}
	}
}

async function deleteRefreshToken(environmentName: string, keytar?: typeof keytarType) {
	if (keytar) {
		try {
			await keytar.deletePassword(credentialsSection, environmentName);
		} catch (err) {
			// ignore
		}
	}
}

export const VSSaasEnvironment: IEnvironment = {
	name: 'VSSaaS',
	managementEndpointUrl: 'https://graph.microsoft.com/',
	activeDirectoryEndpointUrl: 'https://login.microsoftonline.com/',
	activeDirectoryResourceId: 'https://graph.microsoft.com/',
	oauthAppId: 'cdcf391a-4df6-473f-9bea-2c616df8c925'
}

const staticEnvironments: IEnvironment[] = [
	VSSaasEnvironment
];

const staticEnvironmentNames = [
	...staticEnvironments.map(environment => environment.name)
];

const logVerbose = false;
const commonTenantId = 'common';
const validateAuthority = true;

interface VSCodeAccountWriteable extends VSCodeAccount {
	status: VSCodeLoginStatus;
}

class VSCodeLoginError extends Error {
	constructor(message: string, public reason?: any) {
		super(message);
	}
}

// interface Cache {
// 	subscriptions: {
// 		session: {
// 			environment: string;
// 			userId: string;
// 			tenantId: string;
// 		};
// 	}[];
// }

class ProxyTokenCache {

	public initEnd?: () => void;
	private init = new Promise(resolve => {
		this.initEnd = resolve;
	});

	constructor(private target: any) {
	}

	remove(entries: any, callback: any) {
		this.target.remove(entries, callback)
	}

	add(entries: any, callback: any) {
		this.target.add(entries, callback)
	}

	find(query: any, callback: any) {
		this.init.then(() => {
			this.target.find(query, callback);
		});
	}
}

type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud' | 'cloudChange' | 'tenantChange';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';

export class VSCodeLoginHelper {

	private onStatusChanged = new EventEmitter<VSCodeLoginStatus>();
	private onSessionsChanged = new EventEmitter<void>();
	private tokenCache = new MemoryCache();
	private delayedCache = new ProxyTokenCache(this.tokenCache);
 
	constructor(private context: ExtensionContext, private reporter: TelemetryReporter, private keytar?: typeof keytarType) {
		const subscriptions = this.context.subscriptions;
		subscriptions.push(commands.registerCommand('vscode-account.login', (env: IEnvironment = VSSaasEnvironment) => this.login(env, 'login').catch(console.error)));
		subscriptions.push(commands.registerCommand('vscode-account.logout', () => this.logout().catch(console.error)));
		subscriptions.push(commands.registerCommand('vscode-account.askForLogin', () => this.askForLogin().catch(console.error)));
		
		this.initialize('activation', true)
			.catch(console.error);

		if (logVerbose) {
			const outputChannel = window.createOutputChannel('VSCode Account');
			subscriptions.push(outputChannel);
			this.enableLogging(outputChannel);
		}
	}

	private enableLogging(channel: OutputChannel) {
		Logging.setLoggingOptions({
			level: 3 /* Logging.LOGGING_LEVEL.VERBOSE */,
			log: (level: any, message: any, error: any) => {
				if (message) {
					channel.appendLine(message);
				}
				if (error) {
					channel.appendLine(error);
				}
			}
		});
	}

	api: VSCodeAccount = {
		status: 'Initializing',
		onStatusChanged: this.onStatusChanged.event,
		waitForLogin: () => this.waitForLogin(),
		sessions: [],
		onSessionsChanged: this.onSessionsChanged.event,
		getToken: (environment?: IEnvironment) => {
			return this.getToken(environment);
		},
		logOut: () => {
			return this.logout();
		}
	};

	private getToken = async (environment?: IEnvironment) => {
		environment = environment || VSSaasEnvironment;

		const isLoggedIn = await this.waitForLogin();

		if (isLoggedIn) {
			try {
				const token = await this.getTokenForEnvironment(environment);
				return token;
			} catch (e) {}
		}

		return await this.login(environment, 'login');
	}

	async login(environment: IEnvironment, trigger: LoginTrigger) {
		let path: CodePath = 'newLogin';
		let environmentName = 'uninitialized';
		const cancelSource = new CancellationTokenSource();
		try {
			environmentName = environment.name;
			const online = becomeOnline(environment, 2000, cancelSource.token);
			const timer = delay(2000, true);
			if (await Promise.race([ online, timer ])) {
				const cancel = { title: localize('azure-account.cancel', "Cancel") };
				await Promise.race([
					online,
					window.showInformationMessage(localize('vscode-account.checkNetwork', "You appear to be offline. Please check your network connection."), cancel)
						.then(result => {
							if (result === cancel) {
								throw new VSCodeLoginError(localize('vscode-account.offline', "Offline"));
							}
						})
				]);
				await online;
			}
			this.beginLoggingIn();
			const tenantId = getTenantId();
			path = 'newLoginCodeFlow';
			const tokenResponse = await codeFlowLogin.login(environment.oauthAppId, environment, false, tenantId, openUri);
			const refreshToken = tokenResponse.refreshToken!;
			const keytar = this.keytar || keytarModule;
			await storeRefreshToken(environment, refreshToken, keytar);
			await this.updateSessions(environment, [tokenResponse]);
			this.sendLoginTelemetry(trigger, path, environmentName, 'success');

			return {
				accessToken: tokenResponse.accessToken,
				refreshToken: tokenResponse.refreshToken,
				expiresIn: tokenResponse.expiresIn,
				expiresOn: tokenResponse.expiresOn
			}
		} catch (err) {
			if (err instanceof VSCodeLoginError && err.reason) {
				console.error(err.reason);
				this.sendLoginTelemetry(trigger, path, environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
			} else {
				this.sendLoginTelemetry(trigger, path, environmentName, 'failure', getErrorMessage(err));
			}
			throw err;
		} finally {
			cancelSource.cancel();
			cancelSource.dispose();
			this.updateStatus();
		}
	}

	sendLoginTelemetry(trigger: LoginTrigger, path: CodePath, cloud: string, outcome: string, message?: string) {
		/* __GDPR__
		   "login" : {
			  "trigger" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "path": { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "cloud" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
		   }
		 */
		const event: Record<string, string> = { trigger, path, cloud, outcome };
		if (message) {
			event.message = message;
		}
		this.reporter.sendTelemetryEvent('login', event);
	}

	async logout() {
		await this.api.waitForLogin();
		for (const name of staticEnvironmentNames) {
			const keytar = this.keytar || keytarModule;
			await deleteRefreshToken(name, keytar);
		}
		await this.clearSessions();
		this.updateStatus();
	}

	private async getTokenForEnvironment(environment: IEnvironment): Promise<Token> {
		const tenantId = getTenantId();
		const keytar = this.keytar || keytarModule;
		const refreshToken = await getRefreshToken(environment, true, keytar);
		if (!refreshToken) {
			throw new VSCodeLoginError(localize('vscode-account.refreshTokenMissing', "Not signed in"));
		}
		await becomeOnline(environment, 5000);
		this.beginLoggingIn();
		const tokenResponse = await tokenFromRefreshToken(environment, refreshToken, tenantId);
		// For testing
		if (workspace.getConfiguration('azure').get('testTokenFailure')) {
			throw new VSCodeLoginError(localize('vscode-account.testingAquiringTokenFailed', "Testing: Acquiring token failed"));
		}
		await this.updateSessions(environment, [tokenResponse]);

		return {
			accessToken: tokenResponse.accessToken,
			refreshToken: tokenResponse.refreshToken!,
			expiresIn: tokenResponse.expiresIn,
			expiresOn: tokenResponse.expiresOn
		}
	}

	private async initialize(trigger: LoginTrigger, migrateToken?: boolean) {
		let environmentName = 'uninitialized';
		try {
			const environment = getSelectedEnvironment();
			await this.getTokenForEnvironment(environment);
			this.sendLoginTelemetry(trigger, 'tryExisting', environmentName, 'success');
		} catch (err) {
			await this.clearSessions(); // clear out cached data
			if (err instanceof VSCodeLoginError && err.reason) {
				this.sendLoginTelemetry(trigger, 'tryExisting', environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
			} else {
				this.sendLoginTelemetry(trigger, 'tryExisting', environmentName, 'failure', getErrorMessage(err));
			}
		} finally {
			this.updateStatus();
		}
	}

	// private loadCache() {
	// 	const cache = this.context.globalState.get<Cache>('cache');
	// 	if (cache) {
	// 		(<VSCodeAccountWriteable>this.api).status = 'LoggedIn';
	// 		this.initializeSessions(cache);
	// 	}
	// }

	private beginLoggingIn() {
		if (this.api.status !== 'LoggedIn') {
			(<VSCodeAccountWriteable>this.api).status = 'LoggingIn';
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private updateStatus() {
		const status = this.api.sessions.length ? 'LoggedIn' : 'LoggedOut';
		if (this.api.status !== status) {
			(<VSCodeAccountWriteable>this.api).status = status;
			this.onStatusChanged.fire(this.api.status);
		}
	}

	// private initializeSessions(cache: Cache) {
	// 	const sessions: Record<string, ISession> = {};
	// 	for (const { session } of cache.subscriptions) {
	// 		const { environment, userId, tenantId } = session;
	// 		const key = `${environment} ${userId} ${tenantId}`;
	// 		if (!sessions[key]) {
	// 			sessions[key] = {
	// 				environment: VSSaasEnvironment,
	// 				userId,
	// 				tenantId
	// 			};
	// 			this.api.sessions.push(sessions[key]);
	// 		}
	// 	}
	// 	return sessions;
	// }

	private async updateSessions(environment: IEnvironment, tokenResponses: TokenResponse[]) {
		await clearTokenCache(this.tokenCache);
		for (const tokenResponse of tokenResponses) {
			await addTokenToCache(environment, this.tokenCache, tokenResponse);
		}
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
		sessions.splice(0, sessions.length, ...tokenResponses.map<ISession>(tokenResponse => ({
			environment,
			userId: tokenResponse.userId!,
			tenantId: tokenResponse.tenantId!,
			token: {
				accessToken: tokenResponse.accessToken,
				refreshToken: tokenResponse.refreshToken,
				expiresIn: tokenResponse.expiresIn
			}
		})));
		this.onSessionsChanged.fire();
	}

	private async clearSessions() {
		await clearTokenCache(this.tokenCache);
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
		sessions.length = 0;
		this.onSessionsChanged.fire();
	}

	private async askForLogin() {
		if (this.api.status === 'LoggedIn') {
			return;
		}
		const login = { title: localize('azure-account.login', "Sign In") };
		const result = await window.showInformationMessage(localize('azure-account.loginFirst', "Not signed in, sign in first."), login);
		return result === login && commands.executeCommand('azure-account.login');
	}

	async noSubscriptionsFound(): Promise<void> {
		const open: MessageItem = { title: localize('azure-account.open', "Open") };
		const response = await window.showInformationMessage(localize('azure-account.noSubscriptionsFound', "No subscriptions were found. Set up your account at https://azure.microsoft.com/en-us/free/."), open);
		if (response === open) {
			env.openExternal(Uri.parse('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account'));
		}
	}

	private async waitForLogin() {
		switch (this.api.status) {
			case 'LoggedIn':
				return true;
			case 'LoggedOut':
				return false;
			case 'Initializing':
			case 'LoggingIn':
				return new Promise<boolean>(resolve => {
					const subscription = this.api.onStatusChanged(() => {
						subscription.dispose();
						resolve(this.waitForLogin());
					});
				});
			default:
				const status: never = this.api.status;
				throw new Error(`Unexpected status '${status}'`);
		}
	}
}

function getSelectedEnvironment(): IEnvironment {
	return VSSaasEnvironment;
	// const envConfig = workspace.getConfiguration('azure');
	// const envSetting = envConfig.get<string>('cloud');
	// return getEnvironments().find(environment => environment.name === envSetting) || VSSaasEnvironment;
}

function getTenantId() {
	const envConfig = workspace.getConfiguration('azure');
	return envConfig.get<string>('tenant') || commonTenantId;
}

// export async function acquireToken(session: ISession) {
// 	return new Promise<Token>((resolve, reject) => {
// 		// const credentials: any = session.credentials;
// 		const environment: any = session.environment;
// 		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
// 			if (err) {
// 				reject(err);
// 			} else {
// 				resolve({
// 					session,
// 					accessToken: result.accessToken,
// 					refreshToken: result.refreshToken
// 				});
// 			}
// 		});
// 	});
// }

export async function tokenFromRefreshToken(environment: IEnvironment, refreshToken: string, tenantId: string, resource?: string) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, validateAuthority, tokenCache);
		context.acquireTokenWithRefreshToken(refreshToken, environment.oauthAppId, <any>resource, (err, tokenResponse) => {
			if (err) {
				reject(new VSCodeLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), err));
			} else if (tokenResponse.error) {
				reject(new VSCodeLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), tokenResponse));
			} else {
				resolve(<TokenResponse>tokenResponse);
			}
		});
	});
}

async function addTokenToCache(environment: IEnvironment, tokenCache: any, tokenResponse: TokenResponse) {
	return new Promise<any>((resolve, reject) => {
		const driver = new CacheDriver(
			{ _logContext: createLogContext('') },
			`${environment.activeDirectoryEndpointUrl}${tokenResponse.tenantId}`,
			tokenResponse.resource,
			environment.oauthAppId,
			tokenCache,
			(entry: any, resource: any, callback: (err: any, response: any) => {}) => {
				callback(null, entry);
			}
		);
		driver.add(tokenResponse, function (err: any) {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

async function clearTokenCache(tokenCache: any) {
	await new Promise<void>((resolve, reject) => {
		tokenCache.find({}, (err: any, entries: any[]) => {
			if (err) {
				reject(err);
			} else {
				tokenCache.remove(entries, (err: any) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			}
		});
	});
}

export interface PartialList<T> extends Array<T> {
	nextLink?: string;
}

export async function listAll<T>(client: { listNext(nextPageLink: string): Promise<PartialList<T>>; }, first: Promise<PartialList<T>>): Promise<T[]> {
	const all: T[] = [];
	for (let list = await first; list.length || list.nextLink; list = list.nextLink ? await client.listNext(list.nextLink) : []) {
		all.push(...list);
	}
	return all;
}

function delay<T = void>(ms: number, result?: T) {
	return new Promise<T>(resolve => setTimeout(() => resolve(result), ms));
}

function getErrorMessage(err: any): string | undefined {
	if (!err) {
		return;
	}

	if (err.message && typeof err.message === 'string') {
		return err.message;
	}

	if (err.stack && typeof err.stack === 'string') {
		return err.stack.split('\n')[0];
	}

	const str = String(err);
	if (!str || str === '[object Object]') {
		const ctr = err.constructor;
		if (ctr && ctr.name && typeof ctr.name === 'string') {
			return ctr.name;
		}
	}

	return str;
}

async function becomeOnline(environment: IEnvironment, interval: number, token = new CancellationTokenSource().token) {
	let o = isOnline(environment);
	let d = delay(interval, false);
	while (!token.isCancellationRequested && !await Promise.race([o, d])) {
		await d;
		o = asyncOr(o, isOnline(environment));
		d = delay(interval, false);
	}
}

async function isOnline(environment: IEnvironment) {
	try {
		await new Promise<http.IncomingMessage | https.IncomingMessage>((resolve, reject) => {
			const url = environment.activeDirectoryEndpointUrl;
			(url.startsWith('https:') ? https : http).get(url, resolve)
				.on('error', reject);
		});
		return true;
	} catch (err) {
		return false;
	}
}

async function asyncOr<A, B>(a: Promise<A>, b: Promise<B>) {
	return Promise.race([awaitAOrB(a, b), awaitAOrB(b, a)]);
}

async function awaitAOrB<A, B>(a: Promise<A>, b: Promise<B>) {
	return (await a) || b;
}

async function openUri(uri: string) {
	await env.openExternal(Uri.parse(uri));
}