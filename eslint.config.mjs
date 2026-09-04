import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
	{
		ignores: [
			'main.js',
			'node_modules/**',
			'backups/**',
			'**/*.test.ts',
			// Test-only scaffolding, alongside the test files themselves: it
			// uses jest globals that the plugin's own lint config does not
			// declare, and it never ships in the bundle.
			'src/__mocks__/**',
			'src/**/test-support.ts',
			'jest.config.js',
			'jest.setup.js',
			'esbuild.config.mjs',
			'version-bump.mjs',
			'test-*.js',
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/ban-ts-comment': 'off',
		},
	},
);
