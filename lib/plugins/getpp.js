import { jidNormalizedUser } from 'baileys';
import { command } from '../core/registry.js';
function targetJid(m) {
    if (m.quoted?.sender)
        return jidNormalizedUser(m.quoted.sender);
    if (m.mentioned.length)
        return jidNormalizedUser(m.mentioned[0]);
    return m.sender;
}
command({ pattern: 'getpp', desc: "Get a person's profile picture", usage: '[@user | reply]', category: 'tools' }, async (m) => {
    const jid = targetJid(m);
    let url;
    try {
        url = await m.client.profilePictureUrl(jid, 'image');
    }
    catch {
    }
    if (!url)
        return m.reply('This person does not have a profile picture.');
    await m.send({ image: { url }, caption: '📸 Profile picture' }, { quoted: m.raw });
});
