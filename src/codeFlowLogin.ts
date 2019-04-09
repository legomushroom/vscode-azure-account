//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AzureEnvironment } from 'ms-rest-azure';
import { TokenResponse, AuthenticationContext } from 'adal-node';
import { DEFAULT_CLIENT_ID } from './constants';

const redirectUrlAAD = 'https://vscode-redirect.azurewebsites.net/';
const redirectUrlADFS = 'http://127.0.0.1:9472/';

export function isADFS(environment: AzureEnvironment) {
	const u = url.parse(environment.activeDirectoryEndpointUrl);
	const pathname = (u.pathname || '').toLowerCase();
	return pathname === '/adfs' || pathname.startsWith('/adfs/');
}

export async function checkRedirectServer(adfs: boolean) {
	if (adfs) {
		return true;
	}
	let timer: NodeJS.Timer | undefined;
	const promise = new Promise<boolean>(resolve => {
		const req = https.get({
			...url.parse(`${redirectUrlAAD}?state=3333,cccc`),
		}, res => {
			const key = Object.keys(res.headers)
				.find(key => key.toLowerCase() === 'location');
			const location = key && res.headers[key]
			resolve(res.statusCode === 302 && typeof location === 'string' && location.startsWith('http://127.0.0.1:3333/callback'));
		});
		req.on('error', err => {
			console.error(err);
			resolve(false);
		});
		req.on('close', () => {
			resolve(false);
		});
		timer = setTimeout(() => {
			resolve(false);
			req.abort();
		}, 5000);
	});
	function cancelTimer() {
		if (timer) {
			clearTimeout(timer);
		}
	}
	promise.then(cancelTimer, cancelTimer);
	return promise;
}

export async function login(clientId: string, environment: AzureEnvironment, adfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>) {
	const nonce = crypto.randomBytes(16).toString('base64');
	const { server, codePromise } = createServer(nonce);

	try {
		const port = await startServer(server);
		const state = `${port},${encodeURIComponent(nonce)}`;
		const redirectUrlAAD = `http://localhost:${port}/callback`;
		const redirectUrl = adfs ? redirectUrlADFS : redirectUrlAAD;

		await openUri(`${environment.activeDirectoryEndpointUrl}${tenantId}/oauth2/authorize?response_type=code&response_mode=query&client_id=${encodeURIComponent(clientId)}&scope=openid%20offline_access%20https%3A%2F%2Fgraph.microsoft.com%2Fuser.read&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`);

		const codeRes = await codePromise;
		const res = codeRes.res;
		try {
			if ('err' in codeRes) {
				throw codeRes.err;
			}
			const tokenResponse = await tokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, codeRes.code);
			console.log('1');
			res.writeHead(302, { Location: '/' });
			console.log('2');
			res.end();
			console.log('3');
			return tokenResponse;
		} catch (err) {
			console.log(`-=-=-=-=-= err!`, err);
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unkown error')}` });
			res.end();
			throw err;
		}
	} finally {
		setTimeout(() => {
			server.close();
		}, 5000);
	}
}

function createServer(nonce: string) {
	let codeTimer: NodeJS.Timer;
	let server: http.Server;
	function cancelCodeTimer() {
		clearTimeout(codeTimer);
	}
	const codePromise = new Promise<{ code: string; res: http.ServerResponse; } | { err: any; res: http.ServerResponse; }>((resolve, reject) => {
		codeTimer = setTimeout(() => {
			reject(new Error('Timeout waiting for code'));
		}, 5 * 60 * 1000);
		server = http.createServer(function (req, res) {
			const reqUrl = url.parse(req.url!, /* parseQueryString */ true);
			switch (reqUrl.pathname) {
				case '/':
					sendFile(res, path.join(__dirname, '../codeFlowResult/index.html'), 'text/html; charset=utf-8');
					break;
				case '/main.css':
					sendFile(res, path.join(__dirname, '../codeFlowResult/main.css'), 'text/css; charset=utf-8');
					break;
				case '/callback':
					resolve(callback(nonce, reqUrl)
						.then(code => ({ code, res }), err => ({ err, res })));
					break;
				default:
					res.writeHead(404);
					res.end();
					break;
			}
		});
	});
	codePromise.then(cancelCodeTimer, cancelCodeTimer);
	return {
		server: server!,
		codePromise
	};
}

function sendFile(res: http.ServerResponse, filepath: string, contentType: string) {
	fs.readFile(filepath, (err, body) => {
		if (err) {
			console.error(err);
		} else {
			res.writeHead(200, {
				'Content-Length': body.length,
				'Content-Type': contentType
			});
			res.end(body);
		}
	});
}

async function startServer(server: http.Server) {
	let portTimer: NodeJS.Timer;
	function cancelPortTimer() {
		clearTimeout(portTimer);
	}
	const port = new Promise<number>((resolve, reject) => {
		portTimer = setTimeout(() => {
			reject(new Error('Timeout waiting for port'));
		}, 5000);
		server.on('listening', () => {
			const address = server.address();
			resolve(address.port);
		});
		server.on('error', err => {
			reject(err);
		});
		server.on('close', () => {
			reject(new Error('Closed'));
		});
		server.listen(0, 'localhost');
	});
	port.then(cancelPortTimer, cancelPortTimer);
	return port;
}

async function callback(nonce: string, reqUrl: url.Url): Promise<string> {
	let error = reqUrl.query.error_description || reqUrl.query.error;

	console.log(nonce, JSON.stringify(reqUrl), reqUrl.query.state, reqUrl.query.nonce);

	if (!error) {
		const state = reqUrl.query.state || '';
		const receivedNonce = (state.split(',')[1] || '').replace(/ /g, '+');
		if (receivedNonce !== nonce) {
			error = 'Nonce does not match.';
		}
	}

	const code = reqUrl.query.code;
	if (!error && code) {
		return code;
	}
	throw new Error(error || 'No code received.');
}

async function tokenWithAuthorizationCode(clientId: string, environment: AzureEnvironment, redirectUrl: string, tenantId: string, code: string) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`);

		console.log(`\n\n===>>> tokenWithAuthorizationCode: \n\n`);

		console.log(`environment.activeDirectoryEndpointUrl: ${environment.activeDirectoryEndpointUrl}`);
		console.log(`tenantId: ${tenantId}`)

		context.acquireTokenWithAuthorizationCode(code, redirectUrl, environment.activeDirectoryResourceId, clientId, <any>undefined, (err, response) => {
			console.log(err);
			console.log(response);
			console.log(clientId);

			if (err) {
				reject(err);
			} if (response && response.error) {
				reject(new Error(`${response.error}: ${response.errorDescription}`));
			} else {
				resolve(<TokenResponse>response);
			}
		});
	});
}

if (require.main === module) {
	login(DEFAULT_CLIENT_ID, AzureEnvironment.Azure, false, 'common', async uri => console.log(`Open: ${uri}`))
		.catch(console.error);
}
