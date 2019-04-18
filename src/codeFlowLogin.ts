//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as url from 'url';
import * as crypto from 'crypto';
import { VSSaasEnvironment } from './vscode-account';
import { IEnvironment } from './vscode-account.api';
import fetch from 'node-fetch';
import * as Bluebird from 'bluebird';
 
(fetch as any).Promise = Bluebird;

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
		await openUri(`${environment.activeDirectoryEndpointUrl}${tenantId}/oauth2/authorize?response_type=code&response_mode=query&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&prompt=select_account&resource=${encodeURIComponent('https://graph.microsoft.com')}`);

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
		const scope = 'openid offline_access https://graph.microsoft.com/user.read';
		const grantType = 'authorization_code';
		const params = new url.URLSearchParams();

		params.append('client_id', clientId);
		params.append('scope', scope);
		params.append('redirect_uri', redirectUrl);
		params.append('grant_type', grantType);
		params.append('code', code);

		const result = await fetch(
			`https://login.microsoftonline.com/common/oauth2/v2.0/token`,
			{
				method: 'POST',
				body: params
		});

		const resultJSON = await result.json();

		return {
			accessToken: resultJSON.access_token,
			refreshToken: resultJSON.refresh_token,
			expiresIn: resultJSON.expires_in,
			expiresOn: `${Date.now() + (resultJSON.expires_in as number)}`,
			tokenType: resultJSON.token_type,
			resource: environment.activeDirectoryResourceId
		};
}

if (require.main === module) {
	login(VSSaasEnvironment.oauthAppId, VSSaasEnvironment, false, 'common', async uri => console.log(`Open: ${uri}`))
		.catch(console.error);
}
