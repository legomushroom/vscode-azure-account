//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as url from 'url';
// import * as path from 'path';
import * as crypto from 'crypto';
// import { TokenResponse, AuthenticationContext } from 'adal-node';
import { VSSaasEnvironment } from './vscode-account';
import { IEnvironment } from './vscode-account.api';
const fetch = require('node-fetch').default;
const Bluebird = require('bluebird');

console.log(fetch);
 
fetch.Promise = Bluebird;

import indexHtmlFileContents from '../codeFlowResult/index.html';	
import indexCSSFileContents from '../codeFlowResult/main.css';
import { TokenResponse } from 'adal-node';

export async function login(clientId: string, environment: IEnvironment, adfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>) {
	const nonce = crypto.randomBytes(16).toString('base64');
	const { server, codePromise } = createServer(nonce);

	try {
		const port = await startServer(server);
		const state = `${port},${encodeURIComponent(nonce)}`;
		const redirectUrlAAD = `http://localhost:${port}/callback`;
		// const redirectUrlAAD = 'https://vscode-redirect.azurewebsites.net/';
		const redirectUrl = redirectUrlAAD;

		console.log(port);
		
		// https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?
		// 	client_id=6731de76-14a6-49ae-97bc-6eba6914391e
		// 	&response_type=code
		// 	&redirect_uri=http%3A%2F%2Flocalhost%2Fmyapp%2F
		// 	&response_mode=query
		// 	&scope=openid%20offline_access%20https%3A%2F%2Fgraph.microsoft.com%2Fuser.read
		// 	&state=12345
		// https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=a3037261-2c94-4a2e-b53f-090f6cdd712a&response_type=code&redirect_uri=http://localhost:53138/callback&scope=api://9db1d849-f699-4cfb-8160-64bed3335c72/All&state=53138,QQAGL7Qa4bYJtIFyavhBzg==
		// const scope = `&scope=openid%20offline_access%20https%3A%2F%2Fgraph.microsoft.com%2Fuser.read`;
		const scope = ``;
		await openUri(`${environment.activeDirectoryEndpointUrl}${tenantId}/oauth2/authorize?response_type=code&response_mode=query&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&prompt=select_account&resource=${encodeURIComponent('https://graph.microsoft.com')}${scope}`);

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

async function tokenWithAuthorizationCode(clientId: string, environment: IEnvironment, redirectUrl: string, tenantId: string, code: string): Promise<TokenResponse> {
	// return new Promise<TokenResponse>(async (resolve, reject) => {
		// const bod = JSON.parse(`{"url":"https://login.microsoftonline.com/common/oauth2/token?api-version=1.0","body":"grant_type=authorization_code&client_id=a3037261-2c94-4a2e-b53f-090f6cdd712a&resource=api%3A%2F%2F9db1d849-f699-4cfb-8160-64bed3335c72&redirect_uri=http%3A%2F%2Flocalhost%3A56479%2Fcallback&code=Mdf961a89-2001-333b-6e48-81fbb4d451a6&client_secret=","headers":{"Content-Type":"application/x-www-form-urlencoded","Accept-Charset":"utf-8","client-request-id":"196eb596-0a2d-42f3-b6cb-3aca639f0e98","return-client-request-id":"true","x-client-SKU":"Node","x-client-Ver":"0.1.28","x-client-OS":"darwin","x-client-CPU":"x64"},"followRedirect":false,"encoding":"utf8"}`);
		
		const result = await fetch(
			`https://login.microsoftonline.com/common/oauth2/v2.0/token?client_id=${clientId}&scope=offline_access&https%3A%2F%2Fgraph.microsoft.com%2Fuser.read&code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent('http://localhost/callback')}`,
			{
				method: 'POST',
				// headers: {"Content-Type":"application/x-www-form-urlencoded","Accept-Charset":"utf-8","client-request-id":clientId,"return-client-request-id":"true","x-client-SKU":"Node","x-client-Ver":"0.1.28","x-client-OS":"darwin","x-client-CPU":"x64"},
				"followRedirect":false,
				// "encoding":"utf8"
		});

		console.log(result);

		return {
			accessToken: '',
			expiresIn: 3900,
			tokenType: '',
			expiresOn: '',
			resource: ''
		};

		// const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`);
		// context.acquireTokenWithAuthorizationCode(code, redirectUrl, environment.activeDirectoryResourceId, clientId, <any>undefined, (err, response) => {
		// 	if (err) {
		// 		reject(err);
		// 	} if (response && response.error) {
		// 		reject(new Error(`${response.error}: ${response.errorDescription}`));
		// 	} else {
		// 		resolve(<TokenResponse>response);
		// 	}
		// });
	// });
}

if (require.main === module) {
	login(VSSaasEnvironment.oauthAppId, VSSaasEnvironment, false, 'common', async uri => console.log(`Open: ${uri}`))
		.catch(console.error);
}
