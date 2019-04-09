/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, ExtensionContext, commands, Uri, workspace, env } from 'vscode';
import { AzureLoginHelper } from './azure-account';
import { AzureAccount } from './azure-account.api';
import { createReporter } from './telemetry';
import * as nls from 'vscode-nls';
import { survey } from './nps';
import { PRODUCT_NAME } from './constants';

const localize = nls.loadMessageBundle();

export function activate(context: ExtensionContext) {
	const reporter = createReporter(context);
	const azureLogin = new AzureLoginHelper(context, reporter);
	const subscriptions = context.subscriptions;
	subscriptions.push(createStatusBarItem(context, azureLogin.api));
	subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
	// subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleLinux', () => cloudConsole(azureLogin.api, 'Linux')));
	// subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleWindows', () => cloudConsole(azureLogin.api, 'Windows')));
	// subscriptions.push(commands.registerCommand('azure-account.uploadFileCloudConsole', uri => uploadFile(azureLogin.api, uri)));
	survey(context, reporter);
	return Promise.resolve(azureLogin.api); // Return promise to work around weird error in WinJS.
}

function createAccount() {
	return env.openExternal(Uri.parse('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account'));
}

function createStatusBarItem(context: ExtensionContext, api: AzureAccount) {
	const statusBarItem = window.createStatusBarItem();
	statusBarItem.command = "azure-account.selectSubscriptions";
	function updateStatusBar() {
		switch (api.status) {
			case 'LoggingIn':
				statusBarItem.text = localize('azure-account.loggingIn', `${PRODUCT_NAME}: Signing in...`);
				statusBarItem.show();
				break;
			case 'LoggedIn':
				if (api.sessions.length) {
					const azureConfig = workspace.getConfiguration('azure');
					const showSignedInEmail = azureConfig.get<boolean>('showSignedInEmail');
					statusBarItem.text = showSignedInEmail ? localize('azure-account.loggedIn', `${PRODUCT_NAME}: {0}`, api.sessions[0].userId) : localize('azure-account.loggedIn', `${PRODUCT_NAME}: Signed In`);
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