import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// tg_bot_token is returned masked. The SMTP form in the settings panel must
// not parse that mask: parsing it would put '••••' into the host/user/password
// fields, and syncSmtpToken would then write those back over the real SMTP
// configuration stored in the database.
const panelPath = fileURLToPath(new URL('../src/frontend/views/admin/components/SettingsPanel.vue', import.meta.url));
const source = readFileSync(panelPath, 'utf8');

function blockOf(marker, from = 0) {
  const start = source.indexOf(marker, from);
  assert.notEqual(start, -1, `${marker} not found`);
  return source.slice(start, source.indexOf('\n})', start) === -1 ? start + 2000 : source.indexOf('\n})', start));
}

test('the SMTP token watcher does not parse a masked token', () => {
  const watcher = blockOf("watch(() => props.settings.tg_bot_token");
  const guard = watcher.indexOf('isMaskedToken(token)');
  const parse = watcher.indexOf('applySmtpToken(token)');

  assert.notEqual(guard, -1, 'the watcher must check for a masked token');
  assert.notEqual(parse, -1, 'the watcher must still parse real tokens');
  assert.ok(guard < parse, 'the mask check must come before the parse');
});

test('switching to the SMTP channel does not parse a masked token', () => {
  const setter = blockOf("if (value === 'smtp') {");
  const guard = setter.indexOf('isMaskedToken(props.settings.tg_bot_token)');
  const parse = setter.indexOf('applySmtpToken(props.settings.tg_bot_token)');

  assert.notEqual(guard, -1, 'the channel setter must check for a masked token');
  assert.notEqual(parse, -1, 'the channel setter must still parse real tokens');
  assert.ok(guard < parse, 'the mask check must come before the parse');
});

test('the mask is recognised from the value the server sent', () => {
  const helper = blockOf('const isMaskedToken = token =>');
  assert.ok(
    helper.includes('secret_mask'),
    'the client must recognise the mask using the value the server sent'
  );
  assert.ok(
    helper.includes('endsWith'),
    'the client must accept both the plain mask and the smtp:// prefixed one'
  );
});

test('a masked token never makes the panel write an empty value back', () => {
  // smtpTokenApplied=true makes syncSmtpToken skip its completeness guard
  // and write buildSmtpToken(smtpConfig) unconditionally. With an empty form
  // that is '', and the next save would clear the stored SMTP configuration.
  // Both masked paths must therefore leave smtpTokenApplied false.
  const setter = blockOf("if (value === 'smtp') {");
  // The branch itself, not the condition above it: the "if" arm checks
  // isMaskedToken too, but that arm is the real-token path.
  const branchStart = setter.indexOf('} else if (isMaskedToken(props.settings.tg_bot_token)) {');
  assert.notEqual(branchStart, -1, 'the masked channel branch was not found');
  const maskedBranch = setter.slice(branchStart, setter.indexOf('} else {', branchStart));
  assert.ok(
    /smtpTokenApplied\.value = false/.test(maskedBranch),
    'the masked channel branch must not set smtpTokenApplied to true'
  );
  assert.ok(
    !/smtpTokenApplied\.value = true/.test(maskedBranch),
    'the masked channel branch must not set smtpTokenApplied to true'
  );

  const watcher = blockOf("watch(() => props.settings.tg_bot_token");
  assert.ok(
    /smtpTokenApplied\.value = !isMaskedToken\(token\)/.test(watcher),
    'the token watcher must derive smtpTokenApplied from whether the token is masked'
  );
});

test('the save-time notification check uses the stored token, not the mask', () => {
  const handler = readFileSync(
    fileURLToPath(new URL('../src/handlers/admin.js', import.meta.url)),
    'utf8'
  );
  const start = handler.indexOf('const clientTgToken = ');
  const end = handler.indexOf('if (webhookEnabled) {', start);
  assert.ok(start !== -1 && end > start, 'the effectiveTgBotToken computation was not found');
  const block = handler.slice(start, end);
  assert.ok(
    /isMaskedSecretValue\(clientTgToken\)/.test(block),
    'the save-time check must recognise a masked client value'
  );
  assert.ok(
    /storedTgToken/.test(block),
    'the save-time check must fall back to the stored token'
  );
});

test('the server keeps the smtp: prefix in the masked Telegram token', () => {
  const settings = readFileSync(
    fileURLToPath(new URL('../src/utils/settings.js', import.meta.url)),
    'utf8'
  );
  assert.ok(
    /maskSecretValue[\s\S]{0,400}smtp:/i.test(settings),
    'maskSecretValue must keep the smtp: prefix so the channel stays detectable'
  );
  assert.ok(
    /SECRET_SETTING_FIELDS\s*=\s*\[[^\]]*'tg_bot_token'/.test(settings),
    'tg_bot_token must be a masked credential field'
  );
});
