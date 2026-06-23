/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { ICliAgentService } from '../common/cliAgent.js';

// The CLI is spawned in the main process (plain pipes, no PTY); the workbench talks to it over
// the `cliAgent` IPC channel registered in app.ts.
registerMainProcessRemoteService(ICliAgentService, 'cliAgent');
