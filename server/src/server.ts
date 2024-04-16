/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	InsertTextFormat,
	Definition,
	Position,
	Location,
	Range,
	FoldingRangeParams,
	FoldingRange,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

interface Symbols {
	[name: string]: {
		insertText: string;
		detail: string;
		documentation: string;
	};
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);
// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let constantsData: Symbols = {};
let variablesData: Symbols = {};
let functionsData: Symbols = {};

connection.onInitialize((params: InitializeParams) => {
	constantsData = params.initializationOptions.constantsData;
	variablesData = params.initializationOptions.variablesData;
	functionsData = params.initializationOptions.functionsData;
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
			},
			hoverProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			foldingRangeProvider: true,
		},
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true,
			},
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders((_event) => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample',
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
let timeout: NodeJS.Timer | undefined = undefined;
documents.onDidChangeContent((change) => {
	if (timeout) {
		clearTimeout(timeout);
	}

	timeout = setTimeout(() => {
		validateTextDocument(change.document);
		parseDocument(change.document);
		timeout = undefined;
	}, 500);
});

const keywords = new Set<string>(['begin', 'end', 'import', 'T', 'F']);
async function parseDocument(document: TextDocument) {
	const text = document.getText();
	const lines = text.split('\n');

	// Clear the symbol table for the current document
	Array.from(symbolTable.keys()).forEach((key) => {
		symbolTable.set(key, []);
	});

	for (let i = 0; i < lines.length; i++) {
		const words = lines[i].split(/[^\w./'"#]+/); // split the line into words

		for (let j = 0; j < words.length; j++) {
			if (ignoreSymbol(words[j]) || j && ignoreSymbol(words[j - 1])) continue;
			if (words[j].match(/^#+/)) break;
			const symbol = words[j];
			const key = `${symbol}`;

			// Update the symbol table
			const locations = symbolTable.get(key) || [];
			locations.push(
				Location.create(
					document.uri,
					Range.create(
						Position.create(i, lines[i].indexOf(symbol)),
						Position.create(i, lines[i].indexOf(symbol) + symbol.length)
					)
				)
			);
			symbolTable.set(key, locations);
		}
	}
}

/**
 * Ignore symbols that are constants, keywords, numbers, or strings
 * @param symbol 
 * @returns boolean indicating whether the symbol should be ignored
 */
function ignoreSymbol(symbol: string) {
	return (
		symbol in constantsData ||
		keywords.has(symbol) ||
		symbol.match(/^\d+$/) ||
		symbol.match(/^['"]$/)
	);
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	const pattern = /\b[A-Z]{20,}\b/g;
	let m: RegExpExecArray | null;

	let problems = 0;
	const diagnostics: Diagnostic[] = [];
	while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
		problems++;
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length),
			},
			message: `${m[0]} is all uppercase.`,
			source: 'ex',
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range),
					},
					message: 'Spelling matters',
				},
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range),
					},
					message: 'Particularly for names',
				},
			];
		}
		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		const constantItems = Object.keys(constantsData).map((label) => ({
			label: label,
			kind: CompletionItemKind.Constant,
		}));

		const variableItems = Object.keys(variablesData).map((label) => ({
			label: label,
			kind: CompletionItemKind.Variable,
		}));

		const functionItems = Object.keys(functionsData).map((label) => ({
			label: label,
			kind: CompletionItemKind.Function,
			insertText: functionsData[label]?.insertText,
			insertTextFormat: InsertTextFormat.Snippet,
		}));
		return [...constantItems, ...variableItems, ...functionItems];
	}
);

// This handler provides the initial list of the completion items.
// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(async (item: CompletionItem): Promise<CompletionItem> => {
	let symbol = null;
	switch (item.kind) {
		case CompletionItemKind.Constant:
			symbol = constantsData[item.label];
			break;
		case CompletionItemKind.Variable:
			symbol = variablesData[item.label];
			break;
		case CompletionItemKind.Function:
			symbol = functionsData[item.label];
			break;
		default:
			break;
	}
	if (symbol) {
		item.detail = symbol.detail;
		item.documentation = symbol.documentation;
	}
	return item;
});

connection.onHover(async ({ textDocument, position }) => {
	const document = documents.get(textDocument.uri);
	if (!document) {
		return null;
	}
	const text = document.getText();
	const symbol = getWordAtPosition(text, position);
	const description = getDescription(symbol);
	if (!description) {
		return null;
	}
	return {
		contents: {
			kind: 'markdown',
			value: description,
		},
	};
});

function getDescription(symbol: string | null): string | null {
	if (!symbol) return null;
	const data = constantsData[symbol] || variablesData[symbol] || functionsData[symbol];
		if (data) {
				const { detail, documentation } = data;
				return `**${detail}**: ${documentation}`;
		}
		return null;
}


function getWordAtPosition(text: string, position: Position): string | null {
	// Simple pattern to get the word at a position
	const pattern = /\w+/g;
	const line = position.line;
	const character = position.character;
	const lineText = text.split('\n')[line];
	let match = null;

	while ((match = pattern.exec(lineText))) {
		if (match.index <= character && pattern.lastIndex >= character) {
			return match[0];
		}
	}
	return null;
}

// Your "symbol table" mapping symbols to their definitions
const symbolTable: Map<string, Location[]> = new Map();
function getReferences(textDocumentPosition: TextDocumentPositionParams) {
	const document = documents.get(textDocumentPosition.textDocument.uri);

	if (!document) {
		return null;
	}

	// Get the word at the given position
	const name = getWordAtPosition(document.getText(), textDocumentPosition.position);

	// Look up the definition in the symbol table
	if (name) {
		const definition = symbolTable.get(name);
		return definition ?? null;
	}
	return null;
}

connection.onDefinition(
	async (
		textDocumentPosition: TextDocumentPositionParams
	): Promise<Definition | null> => {
		const onReferences = getReferences(textDocumentPosition);
		// return the first reference
		return onReferences ? onReferences[0] : null;
	}
);

connection.onReferences(
	async (
		textDocumentPosition: TextDocumentPositionParams
	): Promise<Location[] | null> => {
		return getReferences(textDocumentPosition);
	}
);

connection.onFoldingRanges((params: FoldingRangeParams) => {
  const document = documents.get(params.textDocument.uri);
  const text = document?.getText();
  const foldingRanges: FoldingRange[] = [];

  if (text) {
    const lines = text.split('\n');
    let startLine = -1;
    let startCharacter = -1;
    let endLine = -1;
    let endCharacter = -1;

    lines.forEach((line, i) => {
      const beginMatch = line.match(/begin:(\w+)/);
      const endMatch = line.match(/end:(\w+)/);

      if (beginMatch) {
        startLine = i;
        startCharacter = beginMatch.index || -1;
      }

      if (endMatch && startLine !== -1) {
        endLine = i;
        endCharacter = (endMatch.index || 0) + endMatch[0].length;

        // Create a folding range for this block
        const foldingRange: FoldingRange = {
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        };

        // Add the folding range to our list
        foldingRanges.push(foldingRange);

        // Reset startLine for the next block
        startLine = -1;
      }
    });
  }
  return foldingRanges;
});


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
