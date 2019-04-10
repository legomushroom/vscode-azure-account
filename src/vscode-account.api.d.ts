/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Terminal, Progress, CancellationToken } from 'vscode';
import { ReadStream } from 'fs';

export interface IEnvironment {
	name: string;
	activeDirectoryEndpointUrl: string;
	activeDirectoryResourceId: string;
	managementEndpointUrl: string;
	oauthAppId: string;
	
}
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
	readonly logOut: () => Promise<void>;
}

export interface ISession {
	readonly environment: IEnvironment;
	readonly userId: string;
	readonly tenantId: string;
}
