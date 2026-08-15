import axios from 'axios';
import { groupMeta, invalidateGroup } from './group.js';
import { getGroupConfig } from '../db/index.js';
import { logger } from '../logger.js';
import type { BotContext } from './types.js';
import type { BaileysEventMap, WASocket } from 'baileys';

/**
 * The payload Baileys emits for 'group-participants.update', taken straight from
 * the library so it stays correct across upgrades. Note it also carries `author`
 * (who performed the action) and a 'modify' action we deliberately ignore below.
 */
type ParticipantsUpdate = BaileysEventMap['group-participants.update'];

/**
 * Render a welcome/goodbye template. Supported tokens:
 *   @user  -> mention of the joining/leaving member
 *   @group -> group subject
 *   @count -> current member count
 */
function render(template: string, opts: { user: string; group: string; count: number }): string {
  return template
    .replace(/@user/g, `@${opts.user.split('@')[0]}`)
    .replace(/@group/g, opts.group)
    .replace(/@count/g, String(opts.count));
}

/** Fetch a user's profile picture as a Buffer, or undefined if none/failed. */
async function fetchAvatar(sock: WASocket, jid: string): Promise<Buffer | undefined> {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return undefined;
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 15_000 });
    return Buffer.from(res.data);
  } catch {
    return undefined;
  }
}

/** Handle members joining/leaving: fire welcome/goodbye if enabled for the group. */
export async function handleGroupParticipants(ctx: BotContext, update: ParticipantsUpdate): Promise<void> {
  invalidateGroup(update.id);
  const cfg = getGroupConfig(update.id);

  const wantWelcome = update.action === 'add' && cfg.welcome;
  const wantGoodbye = update.action === 'remove' && cfg.goodbye;
  if (!wantWelcome && !wantGoodbye) return;

  try {
    const meta = await groupMeta(ctx.sock, update.id);
    const count = meta.participants.length;
    const groupName = meta.subject ?? 'the group';
    const template =
      (wantWelcome ? cfg.welcomeMsg : cfg.goodbyeMsg) ??
      (wantWelcome ? 'Welcome @user to @group! 👋' : 'Goodbye @user 👋');

    const { renderWelcomeCard } = await import('./render.js');

    for (const user of update.participants) {
      const caption = render(template, { user, group: groupName, count });
      let card: Buffer | undefined;
      try {
        const avatar = await fetchAvatar(ctx.sock, user);
        card = await renderWelcomeCard({
          title: wantWelcome ? 'WELCOME' : 'GOODBYE',
          name: `+${user.split('@')[0].split(':')[0]}`,
          groupName,
          memberCount: count,
          avatar,
          accent: wantWelcome ? '#7cf0c8' : '#f0917c',
        });
      } catch (err) {
        logger.warn({ err }, 'welcome card render failed, sending text');
      }

      if (card) {
        await ctx.sock.sendMessage(update.id, { image: card, caption, mentions: [user] });
      } else {
        await ctx.sock.sendMessage(update.id, { text: caption, mentions: [user] });
      }
    }
  } catch (err) {
    logger.error({ err, group: update.id }, 'failed to handle participant update');
  }
}
