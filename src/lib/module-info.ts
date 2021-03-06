import assert = require("assert");
import * as path from "path";
import * as ts from "typescript";

import { hasWindowsSlashes, joinPaths, normalizeSlashes, sort } from "../util/util";

import { readFileAndThrowOnBOM } from "./definition-parser";

export default async function getModuleInfo(packageName: string, directory: string, allEntryFilenames: ReadonlyArray<string>): Promise<ModuleInfo> {
	const all = await allReferencedFiles(directory, allEntryFilenames);

	const dependencies = new Set<string>();
	const declaredModules: string[] = [];
	const globals = new Set<string>();

	function addDependency(dependency: string): void {
		if (dependency !== packageName) {
			dependencies.add(dependency);
		}
		// TODO: else throw new Error(`Package ${packageName} references itself. (via ${src.fileName})`);
	}

	for (const sourceFile of all.values()) {
		for (const ref of imports(sourceFile)) {
			if (!ref.startsWith(".")) {
				addDependency(rootName(ref));
			}
		}

		for (const ref of sourceFile.typeReferenceDirectives) {
			addDependency(ref.fileName);
		}

		if (ts.isExternalModule(sourceFile)) {
			if (sourceFileExportsSomething(sourceFile)) {
				declaredModules.push(properModuleName(packageName, sourceFile.fileName));
				const namespaceExport = sourceFile.statements.find(ts.isNamespaceExportDeclaration);
				if (namespaceExport) {
					globals.add(namespaceExport.name.text);
				}
			}
		} else {
			for (const node of sourceFile.statements) {
				switch (node.kind) {
					case ts.SyntaxKind.ModuleDeclaration: {
						const decl = node as ts.ModuleDeclaration;
						const name = decl.name.text;
						if (decl.name.kind === ts.SyntaxKind.StringLiteral) {
							declaredModules.push(assertNoWindowsSlashes(packageName, name));
						} else if (isValueNamespace(decl)) {
							globals.add(name);
						}
						break;
					}
					case ts.SyntaxKind.VariableStatement:
						for (const decl of (node as ts.VariableStatement).declarationList.declarations) {
							if (decl.name.kind === ts.SyntaxKind.Identifier) {
								globals.add(decl.name.text);
							}
						}
						break;
					case ts.SyntaxKind.EnumDeclaration:
					case ts.SyntaxKind.ClassDeclaration:
					case ts.SyntaxKind.FunctionDeclaration: {
						// Deliberately not doing this for types, because those won't show up in JS code and can't be used for ATA
						const nameNode = (node as ts.EnumDeclaration | ts.ClassDeclaration | ts.FunctionDeclaration).name;
						if (nameNode) {
							globals.add(nameNode.text);
						}
					}
				}
			}
		}
	}

	return { declFiles: sort(all.keys()), dependencies, declaredModules, globals: sort(globals) };
}

/**
 * A file is a proper module if it is an external module *and* it has at least one export.
 * A module with only imports is not a proper module; it likely just augments some other module.
 */
function sourceFileExportsSomething({ statements }: ts.SourceFile): boolean {
	return statements.some(statement => {
		switch (statement.kind) {
			case ts.SyntaxKind.ImportEqualsDeclaration:
			case ts.SyntaxKind.ImportDeclaration:
				return false;
			case ts.SyntaxKind.ModuleDeclaration:
				return (statement as ts.ModuleDeclaration).name.kind === ts.SyntaxKind.Identifier;
			default:
				return true;
		}
	});
}

interface ModuleInfo {
	// Every declaration file used (starting from the entry point)
	declFiles: string[];
	dependencies: Set<string>;
	// Anything from a `declare module "foo"`
	declaredModules: string[];
	// Every global symbol
	globals: string[];
}

/**
 * Given a file name, get the name of the module it declares.
 * `foo/index.d.ts` declares "foo", `foo/bar.d.ts` declares "foo/bar", "foo/bar/index.d.ts" declares "foo/bar"
 */
function properModuleName(folderName: string, fileName: string): string {
	const part = path.basename(fileName) === "index.d.ts" ? path.dirname(fileName) : withoutExtension(fileName, ".d.ts");
	return part === "." ? folderName : joinPaths(folderName, part);
}

/** Given "foo/bar/baz", return "foo". */
function rootName(importText: string): string {
	let slash = importText.indexOf("/");
	// Root of `@foo/bar/baz` is `@foo/bar`
	if (importText.startsWith("@")) {
		// Use second "/"
		slash = importText.indexOf("/", slash + 1);
	}
	return slash === -1 ? importText : importText.slice(0, slash);
}

function withoutExtension(str: string, ext: string): string {
	assert(str.endsWith(ext));
	return str.slice(0, str.length - ext.length);
}

/** Returns a map from filename (path relative to `directory`) to the SourceFile we parsed for it. */
async function allReferencedFiles(directory: string, entryFilenames: ReadonlyArray<string>): Promise<Map<string, ts.SourceFile>> {
	const seenReferences = new Set<string>();
	const all = new Map<string, ts.SourceFile>();

	async function recur(referencedFrom: string, { text, exact }: Reference): Promise<void> {
		if (seenReferences.has(text)) {
			return;
		}
		seenReferences.add(text);

		const { resolvedFilename, content } = exact
			? { resolvedFilename: text, content: await readFileAndReportErrors(referencedFrom, directory, text, text) }
			: await resolveModule(referencedFrom, directory, text);
		const src = createSourceFile(resolvedFilename, content);
		all.set(resolvedFilename, src);

		const refs = referencedFiles(src, path.dirname(resolvedFilename), directory);
		await Promise.all(Array.from(refs).map(ref => recur(resolvedFilename, ref)));
	}

	await Promise.all(entryFilenames.map(filename => recur("tsconfig.json", { text: filename, exact: true })));
	return all;
}

async function resolveModule(referencedFrom: string, directory: string, filename: string): Promise<{ resolvedFilename: string, content: string }> {
	try {
		const dts = `${filename}.d.ts`;
		return { resolvedFilename: dts, content: await readFileAndThrowOnBOM(directory, dts) };
	} catch (_) {
		const index = joinPaths(filename.endsWith("/") ? filename.slice(0, filename.length - 1) : filename, "index.d.ts");
		const resolvedFilename = index === "./index.d.ts" ?  "index.d.ts" : index;
		return { resolvedFilename, content: await readFileAndReportErrors(referencedFrom, directory, filename, index) };
	}
}

async function readFileAndReportErrors(referencedFrom: string, directory: string, referenceText: string, filename: string): Promise<string> {
	try {
		return await readFileAndThrowOnBOM(directory, filename);
	} catch (err) {
		console.error(`In ${directory}, ${referencedFrom} references ${referenceText}, which can't be read.`);
		throw err;
	}
}

interface Reference {
	/** <reference path> includes exact filename, so true. import "foo" may reference "foo.d.ts" or "foo/index.d.ts", so false. */
	readonly exact: boolean;
	readonly text: string;
}

/**
 * @param subDirectory The specific directory within the DefinitelyTyped directory we are in.
 * For example, `directory` may be `react-router` and `subDirectory` may be `react-router/lib`.
 */
function* referencedFiles(src: ts.SourceFile, subDirectory: string, directory: string): Iterable<Reference> {
	for (const ref of src.referencedFiles) {
		// Any <reference path="foo"> is assumed to be local
		yield addReference({ text: ref.fileName, exact: true });
	}

	for (const ref of imports(src)) {
		if (ref.startsWith(".")) {
			yield addReference({ text: ref, exact: false });
		}
	}

	function addReference({ exact, text }: Reference): Reference {
		// `path.normalize` may add windows slashes
		const full = normalizeSlashes(path.normalize(joinPaths(subDirectory, assertNoWindowsSlashes(src.fileName, text))));
		if (full.startsWith("..")) {
			throw new Error(
				`In ${directory} ${src.fileName}: ` +
				'Definitions must use global references to other packages, not parent ("../xxx") references.' +
				`(Based on reference '${text}')`);
		}
		return { exact, text: full };
	}
}

/**
 * All strings referenced in `import` statements.
 * Does *not* include <reference> directives.
 */
function* imports({ statements }: ts.SourceFile | ts.ModuleBlock): Iterable<string> {
	for (const node of statements) {
		switch (node.kind) {
			case ts.SyntaxKind.ImportDeclaration:
			case ts.SyntaxKind.ExportDeclaration: {
				const { moduleSpecifier } = node as ts.ImportDeclaration | ts.ExportDeclaration;
				if (moduleSpecifier && moduleSpecifier.kind === ts.SyntaxKind.StringLiteral) {
					yield (moduleSpecifier as ts.StringLiteral).text;
				}
				break;
			}

			case ts.SyntaxKind.ImportEqualsDeclaration: {
				const { moduleReference } = node as ts.ImportEqualsDeclaration;
				if (moduleReference.kind === ts.SyntaxKind.ExternalModuleReference) {
					yield parseRequire(moduleReference);
				}
				break;
			}

			case ts.SyntaxKind.ModuleDeclaration: {
				const { name, body } = node as ts.ModuleDeclaration;
				if (name.kind === ts.SyntaxKind.StringLiteral) {
					yield* imports(body as ts.ModuleBlock);
				}
			}
		}
	}
}

function parseRequire(reference: ts.ExternalModuleReference): string {
	const { expression } = reference;
	if (!expression || !ts.isStringLiteral(expression)) {
		throw new Error(`Bad 'import =' reference: ${reference.getText()}`);
	}
	return expression.text;
}

function isValueNamespace(ns: ts.ModuleDeclaration): boolean {
	if (!ns.body) {
		throw new Error("@types should not use shorthand ambient modules");
	}
	return ns.body.kind === ts.SyntaxKind.ModuleDeclaration
		? isValueNamespace(ns.body as ts.ModuleDeclaration)
		: (ns.body as ts.ModuleBlock).statements.some(statementDeclaresValue);
}

function statementDeclaresValue(statement: ts.Statement): boolean {
	switch (statement.kind) {
		case ts.SyntaxKind.VariableStatement:
		case ts.SyntaxKind.ClassDeclaration:
		case ts.SyntaxKind.FunctionDeclaration:
		case ts.SyntaxKind.EnumDeclaration:
			return true;

		case ts.SyntaxKind.ModuleDeclaration:
			return isValueNamespace(statement as ts.ModuleDeclaration);

		case ts.SyntaxKind.InterfaceDeclaration:
		case ts.SyntaxKind.TypeAliasDeclaration:
		case ts.SyntaxKind.ImportEqualsDeclaration:
			return false;

		default:
			throw new Error(`Forgot to implement ambient namespace statement ${ts.SyntaxKind[statement.kind]}`);
	}
}

function assertNoWindowsSlashes(packageName: string, fileName: string): string {
	if (hasWindowsSlashes(fileName)) {
		throw new Error(`In ${packageName}: Use forward slash instead when referencing ${fileName}`);
	}
	return fileName;
}

export async function getTestDependencies(
	pkgName: string,
	directory: string,
	testFiles: Iterable<string>,
	dependencies: ReadonlySet<string>,
): Promise<Iterable<string>> {
	const testDependencies = new Set<string>();

	for (const filename of testFiles) {
		const content = await readFileAndThrowOnBOM(directory, filename);
		const sourceFile = createSourceFile(filename, content);
		const { fileName, referencedFiles, typeReferenceDirectives } = sourceFile;
		const filePath = () => path.join(pkgName, fileName);

		for (const { fileName: ref } of referencedFiles) {
			throw new Error(`Test files should not use '<reference path="" />'. '${filePath()}' references '${ref}'.`);
		}

		for (const { fileName: referencedPackage } of typeReferenceDirectives) {
			if (dependencies.has(referencedPackage)) {
				throw new Error(`'${filePath()}' unnecessarily references '${referencedPackage}', which is already referenced in the type definition.`);
			}
			if (referencedPackage === pkgName) {
				throw new Error(`'${filePath()}' unnecessarily references the package. This can be removed.`);
			}

			testDependencies.add(referencedPackage);
		}

		for (const imported of imports(sourceFile)) {
			if (!imported.startsWith(".") && !dependencies.has(imported) && imported !== pkgName) {
				testDependencies.add(imported);
			}
		}
	}

	return testDependencies;
}

function createSourceFile(filename: string, content: string): ts.SourceFile {
	return ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, /*setParentNodes*/false);
}
