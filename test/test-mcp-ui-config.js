import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';
import { startServerLikeRemote } from './helpers/mcp-server.js';
import { runIfMain } from './helpers/run-if-main.js';
import {
  createMemoizedMcpUiPreviewDecision,
  resolveMcpUiPreviewDecision,
} from '../dist/utils/mcp-ui-previews.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_TOOLS = ['get_config', 'read_file', 'write_file', 'list_directory', 'edit_block'];
const NO_UI_TOOLS = ['get_file_info', 'start_process'];
const UI_META_KEYS = ['ui/resourceUri', 'openai/outputTemplate', 'ui'];

function configPath(home) {
  return path.join(home, '.claude-server-commander', 'config.json');
}

function writeConfig(home, config) {
  const directory = path.dirname(configPath(home));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({
    welcomeOnboardingEligible: false,
    pendingWelcomeOnboarding: false,
    ...config,
  }, null, 2));
}

function stripUiMetadata(tools) {
  return tools.map(({ _meta, ...tool }) => tool);
}

async function run() {
  const failures = [];
  const check = async (name, test) => {
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.stack ?? error.message}`);
    }
  };

  let enabled;
  let disabled;
  let unset;
  try {
    await check('new installs default to previews OFF and report an effective Boolean setting', async () => {
      const fixture = createTestEnv();
      try {
        const server = await startServerLikeRemote(fixture.env);
        try {
          const tools = (await server.client.listTools()).tools;
          assert.equal(tools.find((tool) => tool.name === 'get_config')._meta, undefined);
          assert.deepStrictEqual((await server.client.listResources()).resources, []);
          const config = await server.client.callTool({ name: 'get_config', arguments: {} });
          assert.equal(config.structuredContent, undefined);
          assert.match(config.content[0].text, /"showMcpUI": false/);
          assert.equal(JSON.parse(fs.readFileSync(configPath(fixture.home), 'utf8')).showMcpUI, false);
        } finally {
          await server.close();
        }
      } finally {
        fixture.cleanup();
      }
    });

    await check('preview decisions fail closed for missing, malformed, and rejected setting reads', async () => {
      for (const value of [false, undefined, null, 'true', 'false', 0, 1, {}]) {
        assert.equal(await resolveMcpUiPreviewDecision(async () => value), false, `value ${JSON.stringify(value)} must be OFF`);
      }
      assert.equal(await resolveMcpUiPreviewDecision(async () => { throw new Error('config read failed'); }), false);

      let reads = 0;
      const memoized = createMemoizedMcpUiPreviewDecision(async () => {
        reads++;
        throw new Error('config read failed');
      });
      const [first, second, third] = await Promise.all([memoized(), memoized(), memoized()]);
      assert.deepStrictEqual([first, second, third], [false, false, false]);
      assert.strictEqual(reads, 1, 'a failed read resolves and is cached once rather than poisoning the process');
      assert.strictEqual(memoized(), memoized(), 'all calls reuse the same resolved decision promise');
    });

    await check('explicit true and false control UI metadata and resources without changing tool schemas', async () => {
      enabled = createTestEnv();
      disabled = createTestEnv();
      writeConfig(enabled.home, { showMcpUI: true, abTest_McpUiPreviews: 'notShowMCPUi' });
      writeConfig(disabled.home, {
        showMcpUI: false,
        allowedDirectories: [disabled.home],
        abTest_McpUiPreviews: 'showMCPUi',
      });
      const trueServer = await startServerLikeRemote(enabled.env);
      const falseServer = await startServerLikeRemote(disabled.env);
      try {
        const trueTools = (await trueServer.client.listTools()).tools;
        const falseTools = (await falseServer.client.listTools()).tools;
        assert.deepStrictEqual(falseTools.map(({ name }) => name), trueTools.map(({ name }) => name));
        assert.deepStrictEqual(stripUiMetadata(falseTools), stripUiMetadata(trueTools));
        for (const name of ['get_config', 'set_config_value']) {
          const tool = trueTools.find(({ name: toolName }) => toolName === name);
          assert.match(tool.description, /showMcpUI/);
          assert.match(tool.description, /server restart/i);
        }
        for (const name of UI_TOOLS) {
          const trueTool = trueTools.find((tool) => tool.name === name);
          const falseTool = falseTools.find((tool) => tool.name === name);
          assert(trueTool, `missing ${name}`);
          assert(UI_META_KEYS.some((key) => key in (trueTool._meta ?? {})), `${name} should advertise UI metadata when enabled`);
          assert.deepStrictEqual(falseTool._meta, undefined, `${name} should not advertise UI metadata when disabled`);
        }
        for (const name of NO_UI_TOOLS) {
          assert.deepStrictEqual(falseTools.find((tool) => tool.name === name)._meta, trueTools.find((tool) => tool.name === name)._meta);
        }
        const resources = (await trueServer.client.listResources()).resources;
        assert.deepStrictEqual(resources.map(({ uri }) => uri).sort(), [
          'ui://desktop-commander/config-editor',
          'ui://desktop-commander/file-preview',
        ]);
        const preview = await trueServer.client.readResource({ uri: 'ui://desktop-commander/file-preview' });
        assert.match(preview.contents[0].text, /<html/i);
        const editor = await trueServer.client.readResource({ uri: 'ui://desktop-commander/config-editor' });
        assert.match(editor.contents[0].text, /<html/i);
        const enabledConfig = await trueServer.client.callTool({ name: 'get_config', arguments: {} });
        assert(enabledConfig.structuredContent?.config, 'enabled get_config keeps the editor payload');
        assert.deepStrictEqual((await falseServer.client.listResources()).resources, []);
        for (const resource of ['ui://desktop-commander/file-preview', 'ui://desktop-commander/config-editor']) {
          await assert.rejects(falseServer.client.readResource({ uri: resource }));
        }
        const configResult = await falseServer.client.callTool({ name: 'get_config', arguments: {} });
        assert.match(configResult.content[0].text, /Current configuration:/);
        assert.equal(configResult.structuredContent, undefined, 'disabled get_config must omit its widget payload');
        const file = path.join(disabled.home, 'ui-disabled.txt');
        fs.writeFileSync(file, 'before\n');
        const read = await falseServer.client.callTool({ name: 'read_file', arguments: { path: file, origin: 'llm' } });
        assert.match(read.content.map(({ text }) => text ?? '').join('\n'), /before/);
        const write = await falseServer.client.callTool({ name: 'write_file', arguments: { path: file, content: 'after\n', mode: 'rewrite', origin: 'llm' } });
        assert.notEqual(write.isError, true, write.content?.[0]?.text);
        const edit = await falseServer.client.callTool({ name: 'edit_block', arguments: { file_path: file, old_string: 'after', new_string: 'edited', origin: 'llm' } });
        assert.notEqual(edit.isError, true, edit.content?.[0]?.text);
        assert.match(fs.readFileSync(file, 'utf8'), /edited/);
        const list = await falseServer.client.callTool({ name: 'list_directory', arguments: { path: disabled.home, origin: 'llm' } });
        assert.notEqual(list.isError, true);
        const info = await falseServer.client.callTool({ name: 'get_file_info', arguments: { path: file } });
        assert.notEqual(info.isError, true);
      } finally {
        await trueServer.close();
        await falseServer.close();
      }
    });

    await check('a server process resolves the setting once, despite config writes and repeated tools/list calls', async () => {
      const fixture = createTestEnv();
      unset = fixture;
      writeConfig(fixture.home, {
        allowedDirectories: [fixture.home],
        abTest_McpUiPreviews: 'showMCPUi',
      });
      let server = await startServerLikeRemote(fixture.env);
      try {
        const [firstResponse, simultaneousResponse] = await Promise.all([
          server.client.listTools(),
          server.client.listTools(),
        ]);
        const first = firstResponse.tools;
        assert.deepStrictEqual(simultaneousResponse.tools, first, 'simultaneous initial tools/list calls must agree');
        const firstGetConfig = first.find((tool) => tool.name === 'get_config');
        assert.equal(firstGetConfig._meta, undefined, 'legacy A/B show assignment must not enable previews');
        const set = await server.client.callTool({ name: 'set_config_value', arguments: { key: 'showMcpUI', value: false } });
        assert.notEqual(set.isError, true, set.content?.[0]?.text);
        assert.match(set.content[0].text, /Successfully set showMcpUI to false/);
        const second = (await server.client.listTools()).tools;
        assert.deepStrictEqual(second, first, 'tools/list metadata must remain fixed until restart');
        const get = await server.client.callTool({ name: 'get_config', arguments: {} });
        assert.equal(get.structuredContent, undefined);
        assert.match(get.content[0].text, /"showMcpUI": false/);
        assert.match(fs.readFileSync(configPath(fixture.home), 'utf8'), /"showMcpUI": false/);
        for (const value of ['false', 0]) {
          const invalid = await server.client.callTool({ name: 'set_config_value', arguments: { key: 'showMcpUI', value } });
          assert.equal(invalid.isError, true, `value ${JSON.stringify(value)} must be rejected`);
          const currentConfig = await server.client.callTool({ name: 'get_config', arguments: {} });
          assert.match(currentConfig.content[0].text, /"showMcpUI": false/);
        }
        const unrelated = await server.client.callTool({ name: 'set_config_value', arguments: { key: 'notAConfigField', value: false } });
        assert.equal(unrelated.isError, true);
        assert.match((await server.client.callTool({ name: 'get_config', arguments: {} })).content[0].text, /"showMcpUI": false/);
        await server.close();

        server = await startServerLikeRemote(fixture.env);
        const restartedTools = (await server.client.listTools()).tools;
        assert.equal(restartedTools.find((tool) => tool.name === 'get_config')._meta, undefined,
          'restart applies the persisted false choice');
        assert.deepStrictEqual((await server.client.listResources()).resources, []);
        const setTrue = await server.client.callTool({ name: 'set_config_value', arguments: { key: 'showMcpUI', value: true } });
        assert.notEqual(setTrue.isError, true, setTrue.content?.[0]?.text);
        const updatedTextConfig = await server.client.callTool({ name: 'get_config', arguments: {} });
        assert.match(updatedTextConfig.content[0].text, /"showMcpUI": true/);
        assert.equal(updatedTextConfig.structuredContent, undefined);
        assert.match(fs.readFileSync(configPath(fixture.home), 'utf8'), /"showMcpUI": true/);
        assert.deepStrictEqual((await server.client.listTools()).tools, restartedTools,
          'the current process keeps its decision after the next config write');
        await assert.rejects(server.client.readResource({ uri: 'ui://not-a-resource' }), /Unknown resource URI/);
        const invalidCall = await server.client.callTool({ name: 'not_a_tool', arguments: {} });
        assert.equal(invalidCall.isError, true);
      } finally {
        await server.close();
      }
    });
  } finally {
    enabled?.cleanup();
    disabled?.cleanup();
    unset?.cleanup();
  }

  console.log(`\n${failures.length ? `${failures.length} failed` : 'All MCP UI config checks passed'}`);
  return failures.length === 0;
}

runIfMain(import.meta.url, run);
