/**
 * Jest transformer for the backend's TypeScript sources.
 *
 * The backend compiles its JavaScript with Babel 8, but the TypeScript
 * presets available in this workspace are v7 and refuse to load under
 * Babel 8. TypeScript itself is already part of the toolchain (required by
 * @typescript-eslint's type-aware linting), so types are stripped with the
 * compiler API instead of adding another Babel dependency.
 */
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        sourceMap: false,
      },
    });
    return { code: outputText };
  },
};
