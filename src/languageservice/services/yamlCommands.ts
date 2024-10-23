/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Connection, RequestType } from 'vscode-languageserver';
import { YamlCommands } from '../../commands';
import { CommandExecutor } from '../../languageserver/commandExecutor';
import { URI } from 'vscode-uri';
import { getJobNodes } from './gitlabciUtils';
import { yamlDocumentsCache } from '../parser/yaml-documents';

export function registerCommands(commandExecutor: CommandExecutor, connection: Connection): void {
  commandExecutor.registerCommand(YamlCommands.JUMP_TO_SCHEMA, async (uri: string) => {
    if (!uri) {
      return;
    }
    // if uri points to local file of its a windows path
    if (!uri.startsWith('file') && !/^[a-z]:[\\/]/i.test(uri)) {
      const origUri = URI.parse(uri);
      const customUri = URI.from({
        scheme: 'json-schema',
        authority: origUri.authority,
        path: origUri.path.endsWith('.json') ? origUri.path : origUri.path + '.json',
        fragment: uri,
      });
      uri = customUri.toString();
    }

    // test if uri is windows path, ie starts with 'c:\' and convert to URI
    if (/^[a-z]:[\\/]/i.test(uri)) {
      const winUri = URI.file(uri);
      uri = winUri.toString();
    }

    const result = await connection.window.showDocument({ uri: uri, external: false, takeFocus: true });
    if (!result) {
      connection.window.showErrorMessage(`Cannot open ${uri}`);
    }
  });
}

// Command handler to get all jobs names and their locations
export function registerGetJobsInformation(connection, yamlSettings) {
  const getJobsInformation: RequestType<void, object[], unknown> = new RequestType('yaml/getJobsInformation');
  connection?.onRequest(getJobsInformation, async () => {
    if (!yamlSettings?.gitlabci?.enabled) {
      return [];
    }

    const jobNodes = getJobNodes(yamlDocumentsCache.getAllDocuments());
    const results = [];
    for (let [locationLink, _, node] of jobNodes) {
      const result = {
        jobName: node.key,
        locationUri: locationLink.targetUri,
        locationRange: locationLink.targetRange,
      };
      results.push(result);
    }

    return results;
  });
}
