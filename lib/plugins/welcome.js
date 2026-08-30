import { command } from '../core/registry.js';
import { setGroupConfig, getGroupConfig } from '../db/index.js';
function onOff(arg) {
    const v = arg?.trim().toLowerCase();
    if (v === 'on' || v === 'enable')
        return true;
    if (v === 'off' || v === 'disable')
        return false;
    return undefined;
}
command({ pattern: 'welcome ?(.*)', desc: 'Toggle/set welcome message', usage: 'on|off | <template>', category: 'group', groupOnly: true, adminOnly: true }, async (m, match) => {
    const arg = match?.[1]?.trim();
    const toggle = onOff(arg);
    if (toggle !== undefined) {
        setGroupConfig(m.chat, { welcome: toggle });
        return m.reply(`Welcome messages ${toggle ? 'enabled' : 'disabled'}.`);
    }
    if (arg) {
        setGroupConfig(m.chat, { welcome: true, welcomeMsg: arg });
        return m.reply('Welcome message updated and enabled.\nTokens: @user @group @count');
    }
    const cfg = getGroupConfig(m.chat);
    await m.reply(`Welcome: ${cfg.welcome ? 'on' : 'off'}\nMessage: ${cfg.welcomeMsg ?? '(default)'}`);
});
command({ pattern: 'goodbye ?(.*)', desc: 'Toggle/set goodbye message', usage: 'on|off | <template>', category: 'group', groupOnly: true, adminOnly: true }, async (m, match) => {
    const arg = match?.[1]?.trim();
    const toggle = onOff(arg);
    if (toggle !== undefined) {
        setGroupConfig(m.chat, { goodbye: toggle });
        return m.reply(`Goodbye messages ${toggle ? 'enabled' : 'disabled'}.`);
    }
    if (arg) {
        setGroupConfig(m.chat, { goodbye: true, goodbyeMsg: arg });
        return m.reply('Goodbye message updated and enabled.\nTokens: @user @group @count');
    }
    const cfg = getGroupConfig(m.chat);
    await m.reply(`Goodbye: ${cfg.goodbye ? 'on' : 'off'}\nMessage: ${cfg.goodbyeMsg ?? '(default)'}`);
});
command({
    pattern: 'antilink(?: (on|off|warn|kick))?',
    desc: 'Block links from non-admins',
    usage: 'on | off | warn | kick',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
}, async (m, match) => {
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'off') {
        setGroupConfig(m.chat, { antilink: false });
        return m.reply('Antilink disabled.');
    }
    if (v === 'on' || v === 'warn') {
        setGroupConfig(m.chat, { antilink: true, antilinkAction: 'warn' });
        return m.reply('✅ Antilink enabled (delete + warn, auto-remove after 3 warnings).');
    }
    if (v === 'kick') {
        setGroupConfig(m.chat, { antilink: true, antilinkAction: 'kick' });
        return m.reply('✅ Antilink enabled (delete + remove immediately).');
    }
    const cfg = getGroupConfig(m.chat);
    const state = cfg.antilink ? `on (${cfg.antilinkAction ?? 'warn'})` : 'off';
    await m.reply(`Antilink is ${state}.\nUse: .antilink on | off | warn | kick`);
});
