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
