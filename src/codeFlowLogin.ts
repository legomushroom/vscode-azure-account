//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as url from 'url';
// import * as path from 'path';
import * as crypto from 'crypto';
import { TokenResponse, AuthenticationContext } from 'adal-node';
import { VSSaasEnvironment } from './vscode-account';
import { IEnvironment } from './vscode-account.api';

import indexHtmlFileContents from '../codeFlowResult/index.html';	
import indexCSSFileContents from '../codeFlowResult/main.css';

export async function login(clientId: string, environment: IEnvironment, adfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>) {
	const nonce = crypto.randomBytes(16).toString('base64');
	const { server, codePromise } = createServer(nonce);

	try {
		const port = await startServer(server);
		const state = `${port},${encodeURIComponent(nonce)}`;
		const redirectUrlAAD = `http://localhost:${port}/callback`;
		const redirectUrl = redirectUrlAAD;

		await openUri(`${environment.activeDirectoryEndpointUrl}${tenantId}/oauth2/authorize?response_type=code&response_mode=query&client_id=${encodeURIComponent(clientId)}&scope=openid%20offline_access%20https%3A%2F%2Fgraph.microsoft.com%2Fuser.read&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`);

		const codeRes = await codePromise;
		const res = codeRes.res;
		try {
			if ('err' in codeRes) {
				throw codeRes.err;
			}
			const tokenResponse = await tokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, codeRes.code);
			res.writeHead(302, { Location: '/' });
			res.end();
			return tokenResponse;
		} catch (err) {
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
					sendFile(res, indexHtmlFileContents, 'text/html; charset=utf-8');
					break;
				case '/main.css':
					sendFile(res, indexCSSFileContents, 'text/css; charset=utf-8');
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

function sendFile(res: http.ServerResponse, contents: string, contentType: string) {
	res.writeHead(200, {
		'Content-Length': contents.length,
		'Content-Type': contentType
	});
	res.end(contents);
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

async function tokenWithAuthorizationCode(clientId: string, environment: IEnvironment, redirectUrl: string, tenantId: string, code: string) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`);
		context.acquireTokenWithAuthorizationCode(code, redirectUrl, environment.activeDirectoryResourceId, clientId, <any>undefined, (err, response) => {
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
	login(VSSaasEnvironment.oauthAppId, VSSaasEnvironment, false, 'common', async uri => console.log(`Open: ${uri}`))
		.catch(console.error);
}
