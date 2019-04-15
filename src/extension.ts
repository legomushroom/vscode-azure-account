/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, ExtensionContext, workspace } from 'vscode';
import { VSCodeLoginHelper } from './vscode-account';
import { VSCodeAccount } from './vscode-account.api';
import { createReporter } from './telemetry';
import * as nls from 'vscode-nls';
import * as keytarType from 'keytar';

import { PRODUCT_NAME } from './constants';

const localize = nls.loadMessageBundle();

export const activateInternal = async (context: ExtensionContext, keytar?: typeof keytarType) => {
	const reporter = createReporter(context);
	const azureLogin = new VSCodeLoginHelper(context, reporter, keytar);
	// dont create status bar for now
	// const subscriptions = context.subscriptions;
	// subscriptions.push(createStatusBarItem(context, azureLogin.api));

	return azureLogin.api;
}

export async function activate(context: ExtensionContext) {
	return await activateInternal(context);
}

export function createStatusBarItem(context: ExtensionContext, api: VSCodeAccount) {
	return
	const statusBarItem = window.createStatusBarItem();
	statusBarItem.command = "vscode-account.selectSubscriptions";
	function updateStatusBar() {
		switch (api.status) {
			case 'LoggingIn':
				statusBarItem.text = localize('vscode-account.loggingIn', `${PRODUCT_NAME}: Signing in...`);
				statusBarItem.show();
				break;
			case 'LoggedIn':
				if (api.sessions.length) {
					const azureConfig = workspace.getConfiguration('vscode-account');
					const showSignedInEmail = azureConfig.get<boolean>('showSignedInEmail');
					statusBarItem.text = showSignedInEmail ? localize('vscode-account.loggedIn', `${PRODUCT_NAME}: {0}`, api.sessions[0].userId) : localize('vscode-account.loggedIn', `${PRODUCT_NAME}: Signed In`);
					statusBarItem.show();
				}
				break;
			default:
				statusBarItem.hide();
				break;
		}
	}
	context.subscriptions.push(
		statusBarItem,
		api.onStatusChanged(updateStatusBar),
		api.onSessionsChanged(updateStatusBar),
		workspace.onDidChangeConfiguration(updateStatusBar)
	);
	updateStatusBar();
	return statusBarItem;
}

export function deactivate() {
}