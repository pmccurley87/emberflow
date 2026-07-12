// src/config.ts — the `emberflow` package root: what a consumer's emberflow.config imports.
export { defineConfig } from '../server/projectConfig';
export type { EmberflowUserConfig } from '../server/projectConfig';
export type { NodeRegistry, NodeDefinition, NodeExecutionContext } from './engine';
