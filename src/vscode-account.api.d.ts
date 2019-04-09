/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Terminal, Progress, CancellationToken } from 'vscode';
import { ServiceClientCredentials } from 'ms-rest';
import { AzureEnvironment } from 'ms-rest-azure';
import { SubscriptionModels } from 'azure-arm-resource';
import { ReadStream } from 'fs';
import { IEnvironment } from './vscode-account';

export type VSCodeLoginStatus = 'Initializing' | 'LoggingIn' | 'LoggedIn' | 'LoggedOut';

export interface Token {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
	expiresOn: string | Date;
}

export interface VSCodeAccount {
	readonly status: VSCodeLoginStatus;
	readonly onStatusChanged: Event<VSCodeLoginStatus>;
	readonly waitForLogin: () => Promise<boolean>;
	readonly sessions: ISession[];
	readonly onSessionsChanged: Event<void>;
	readonly getToken: (environment?: IEnvironment) => Promise<void | Token>;
}

export interface ISession {
	readonly environment: IEnvironment;
	readonly userId: string;
	readonly tenantId: string;
}
