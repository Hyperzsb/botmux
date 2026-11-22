import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 非文本断言：真实 React 表单及 CSS 在浏览器中渲染，验证用户选择和提交结果。
describe('dashboard automation execution user', () => {
  let browser: Browser;
  let script: string;
  beforeAll(async () => {
    const result = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createDashboardTranslator } from './src/dashboard/web/i18n.ts';
        import { ScheduleFormModal } from './src/dashboard/web/schedules-page.tsx';
        import { renderConnectorsPage } from './src/dashboard/web/connectors-page.tsx';
        import { ToolIdentitySection } from './src/dashboard/web/bot-defaults-page.tsx';
        const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
        window.fetch = async (input, init) => {
          const url = String(input);
          if (url.startsWith('/api/automation-users')) return json({ users: [
            { openId: 'ou_demo', name: 'Demo User', email: 'demo@example.test' },
            { openId: 'ou_second', name: 'Another User' },
          ] });
          if (url.startsWith('/api/schedules/calendars')) return json({ calendars: [] });
          if (url === '/api/bots') return json({ bots: [{ larkAppId: 'cli_demo', botName: 'Demo Bot' }] });
          if (url === '/api/groups') return json({ chats: [{ chatId: 'oc_demo', name: 'Demo Chat', memberBots: [{ larkAppId: 'cli_demo', inChat: true }] }] });
          if (url === '/api/connectors') {
            if (init?.method === 'POST') {
              window.submitted = JSON.parse(init.body);
              return json({ ok: true, connector: { ...window.submitted, id: 'conn_demo' }, webhookUrl: 'https://example.test/webhook/conn_demo', secret: 'fixture' });
            }
            return json({ connectors: [] });
          }
          if (url === '/api/bots/cli_demo/tool-identity' && init?.method === 'PUT') {
            window.submitted = JSON.parse(init.body);
            const value = window.submitted;
            return json({ ok: true, toolIdentity: value.toolUserOpenId ? {
              user: { larkAppId: 'cli_demo', openId: value.toolUserOpenId, unionId: 'on_demo' },
              tools: value.toolTools,
              credentialSource: value.credentialSource,
            } : null });
          }
          throw new Error('Unexpected fetch: ' + url);
        };
        function ToolFixture() {
          const [bot, setBot] = useState({
            larkAppId: 'cli_demo', botName: 'Demo Bot',
            toolIdentity: {
              user: { larkAppId: 'cli_demo', openId: 'ou_demo', unionId: 'on_demo' },
              tools: ['larkdev'], credentialSource: 'local',
            },
            toolIdentityInvalid: 'legacy invalid marker',
          });
          return <ToolIdentitySection bot={bot} patchBot={(_id, patch) => {
            window.patched = patch;
            setBot(current => ({ ...current, ...patch }));
          }} />;
        }
        if (window.fixtureKind === 'webhook') renderConnectorsPage(document.getElementById('root'));
        else if (window.fixtureKind === 'tool-identity') createRoot(document.getElementById('root')).render(<ToolFixture />);
        else createRoot(document.getElementById('root')).render(<ScheduleFormModal
          open={true} editing={{ id: 'schedule_demo', name: 'Daily review', schedule: '0 9 * * *', prompt: 'Review the project status', larkAppId: 'cli_demo', chatIds: ['oc_demo'], executionPosition: 'top-level' }}
          error={null} bots={[{ larkAppId: 'cli_demo', botName: 'Demo Bot' }]} scheduleTimeZone="Asia/Shanghai"
          tr={createDashboardTranslator('zh')} onClose={() => {}} onSubmit={data => { window.submitted = data; }}
        />);
      ` },
      bundle: true, write: false, format: 'iife', platform: 'browser',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    script = result.outputFiles[0].text;
    const executablePath = process.env.BOTMUX_TEST_BROWSER_EXECUTABLE
      || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  });
  afterAll(async () => { await browser?.close(); });

  for (const kind of ['cron', 'webhook'] as const) {
    it(`submits the selected execution user from the ${kind} form`, async () => {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
      try {
        await page.setContent('<div id="root"></div>');
        await page.evaluate(value => { (window as any).fixtureKind = value; }, kind);
        await page.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
        await page.addScriptTag({ content: script });
        if (kind === 'webhook') {
          await page.locator('.connector-create-trigger').click();
          await page.locator('#cn-name').fill('Incident triage');
        }
        const picker = page.locator('select').filter({ has: page.locator('option[value="ou_demo"]') });
        await picker.selectOption('ou_demo');
        expect(await picker.inputValue()).toBe('ou_demo');
        const outputDir = process.env.BOTMUX_AUTOMATION_SCREENSHOT_DIR;
        if (outputDir) {
          mkdirSync(outputDir, { recursive: true });
          await page.screenshot({ path: `${outputDir}/${kind}-run-as.png`, fullPage: true });
        }
        if (kind === 'webhook') await page.locator('#cn-create').click();
        else await page.locator('.schedule-form button[type="submit"]').click();
        await expect.poll(() => page.evaluate(() => (window as any).submitted?.runAsOpenId)).toBe('ou_demo');
      } finally { await page.close(); }
    });
  }

  it('round-trips fixed tool scope/source and clears its invalid banner after save', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    try {
      await page.setContent('<div id="root"></div>');
      await page.evaluate(() => { (window as any).fixtureKind = 'tool-identity'; });
      await page.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
      await page.addScriptTag({ content: script });

      expect(await page.getByRole('alert').count()).toBe(1);
      expect(await page.locator('[data-action="tool-identity-tool-larkdev"]').isChecked()).toBe(true);
      expect(await page.locator('[data-action="tool-identity-tool-bytedcli"]').isChecked()).toBe(false);
      expect(await page.locator('[data-action="tool-identity-source"]').inputValue()).toBe('local');

      await page.locator('[data-action="tool-identity-tool-bytedcli"]').check();
      await page.locator('[data-action="tool-identity-source"]').selectOption('platform');
      await page.locator('[data-action="save-tool-identity"]').click();

      await expect.poll(() => page.evaluate(() => (window as any).submitted)).toMatchObject({
        toolUserOpenId: 'ou_demo',
        toolTools: ['larkdev', 'bytedcli'],
        credentialSource: 'platform',
      });
      await expect.poll(() => page.evaluate(() => (window as any).patched)).toMatchObject({
        toolIdentity: { tools: ['larkdev', 'bytedcli'], credentialSource: 'platform' },
        toolIdentityInvalid: null,
      });
      await expect.poll(() => page.getByRole('alert').count()).toBe(0);
    } finally { await page.close(); }
  });
});
