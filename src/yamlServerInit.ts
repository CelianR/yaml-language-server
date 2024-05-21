import { Connection, InitializeParams, InitializeResult, TextDocumentSyncKind } from 'vscode-languageserver';
import {
  getLanguageService as getCustomLanguageService,
  LanguageService,
  SchemaRequestService,
  WorkspaceContextService,
} from './languageservice/yamlLanguageService';
import { workspaceFoldersChanged } from './languageservice/utils/paths';
import { URI } from 'vscode-uri';
import { SettingsState } from './yamlSettings';
import { LanguageHandlers } from './languageserver/handlers/languageHandlers';
import { NotificationHandlers } from './languageserver/handlers/notificationHandlers';
import { RequestHandlers } from './languageserver/handlers/requestHandlers';
import { ValidationHandler } from './languageserver/handlers/validationHandlers';
import { SettingsHandler } from './languageserver/handlers/settingsHandlers';
import { YamlCommands } from './commands';
import { WorkspaceHandlers } from './languageserver/handlers/workspaceHandlers';
import { commandExecutor } from './languageserver/commandExecutor';
import { Telemetry } from './languageservice/telemetry';
import { registerCommands } from './languageservice/services/yamlCommands';
import { readFileSync, readdirSync, statSync } from 'fs';
import { yamlDocumentsCache } from './languageservice/parser/yaml-documents';
import { TextDocument } from 'vscode-languageserver-textdocument';

export class YAMLServerInit {
  languageService: LanguageService;
  languageHandler: LanguageHandlers;
  validationHandler: ValidationHandler;
  settingsHandler: SettingsHandler;

  constructor(
    private readonly connection: Connection,
    private yamlSettings: SettingsState,
    private workspaceContext: WorkspaceContextService,
    private schemaRequestService: SchemaRequestService,
    private telemetry: Telemetry
  ) {
    this.yamlSettings.documents.listen(this.connection);

    /**
     * Run when the client connects to the server after it is activated.
     * The server receives the root path(s) of the workspace and the client capabilities.
     */
    this.connection.onInitialize((params: InitializeParams): InitializeResult => {
      return this.connectionInitialized(params);
    });
    this.connection.onInitialized(() => {
      if (this.yamlSettings.hasWsChangeWatchedFileDynamicRegistration) {
        this.connection.workspace.onDidChangeWorkspaceFolders((changedFolders) => {
          this.yamlSettings.workspaceFolders = workspaceFoldersChanged(this.yamlSettings.workspaceFolders, changedFolders);
        });
      }
      // need to call this after connection initialized
      this.settingsHandler.registerHandlers();
      this.settingsHandler.pullConfiguration();
    });
  }

  // public for test setup
  connectionInitialized(params: InitializeParams): InitializeResult {
    this.yamlSettings.capabilities = params.capabilities;
    this.languageService = getCustomLanguageService({
      schemaRequestService: this.schemaRequestService,
      workspaceContext: this.workspaceContext,
      connection: this.connection,
      yamlSettings: this.yamlSettings,
      telemetry: this.telemetry,
      clientCapabilities: params.capabilities,
    });

    // Only try to parse the workspace root if its not null. Otherwise initialize will fail
    if (params.rootUri) {
      this.yamlSettings.workspaceRoot = URI.parse(params.rootUri);
    }
    this.yamlSettings.workspaceFolders = params.workspaceFolders || [];

    this.yamlSettings.hierarchicalDocumentSymbolSupport = !!(
      this.yamlSettings.capabilities.textDocument &&
      this.yamlSettings.capabilities.textDocument.documentSymbol &&
      this.yamlSettings.capabilities.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport
    );
    this.yamlSettings.clientDynamicRegisterSupport = !!(
      this.yamlSettings.capabilities.textDocument &&
      this.yamlSettings.capabilities.textDocument.rangeFormatting &&
      this.yamlSettings.capabilities.textDocument.rangeFormatting.dynamicRegistration
    );
    this.yamlSettings.hasWorkspaceFolderCapability =
      this.yamlSettings.capabilities.workspace && !!this.yamlSettings.capabilities.workspace.workspaceFolders;

    this.yamlSettings.hasConfigurationCapability = !!(
      this.yamlSettings.capabilities.workspace && !!this.yamlSettings.capabilities.workspace.configuration
    );

    this.yamlSettings.hasWsChangeWatchedFileDynamicRegistration = !!(
      this.yamlSettings.capabilities.workspace &&
      this.yamlSettings.capabilities.workspace.didChangeWatchedFiles &&
      this.yamlSettings.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration
    );
    this.registerHandlers();
    registerCommands(commandExecutor, this.connection);

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { resolveProvider: false },
        hoverProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: false,
        documentOnTypeFormattingProvider: {
          firstTriggerCharacter: '\n',
        },
        documentRangeFormattingProvider: false,
        definitionProvider: true,
        documentLinkProvider: {},
        foldingRangeProvider: true,
        selectionRangeProvider: true,
        codeActionProvider: true,
        codeLensProvider: {
          resolveProvider: false,
        },
        executeCommandProvider: {
          commands: Object.keys(YamlCommands).map((k) => YamlCommands[k]),
        },
        workspace: {
          workspaceFolders: {
            changeNotifications: true,
            supported: true,
          },
        },
      },
    };
  }

  private registerFile(path: string): void {
    const content = readFileSync(path, 'utf8');
    const doc = TextDocument.create('file://' + path, 'yaml', 1, content);
    yamlDocumentsCache.getYamlDocument(doc);
  }

  private registerWorkspaceFiles(path: string): void {
    const files = readdirSync(path);
    for (const file of files) {
      const filePath = path + '/' + file;
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        this.registerFile(filePath);
      } else if (statSync(filePath).isDirectory()) {
        this.registerWorkspaceFiles(filePath);
      }
    }
  }

  private registerHandlers(): void {
    // Walk through all the files in the workspace and register them
    for (const folder of this.yamlSettings.workspaceFolders) {
      this.registerWorkspaceFiles(URI.parse(folder.uri).fsPath);
    }

    // Register all features that the language server has
    this.validationHandler = new ValidationHandler(this.connection, this.languageService, this.yamlSettings);
    this.settingsHandler = new SettingsHandler(
      this.connection,
      this.languageService,
      this.yamlSettings,
      this.validationHandler,
      this.telemetry
    );
    // this.settingsHandler.registerHandlers();
    this.languageHandler = new LanguageHandlers(this.connection, this.languageService, this.yamlSettings, this.validationHandler);
    this.languageHandler.registerHandlers();
    new NotificationHandlers(this.connection, this.languageService, this.yamlSettings, this.settingsHandler).registerHandlers();
    new RequestHandlers(this.connection, this.languageService).registerHandlers();
    new WorkspaceHandlers(this.connection, commandExecutor).registerHandlers();
  }

  start(): void {
    this.connection.listen();
  }
}
