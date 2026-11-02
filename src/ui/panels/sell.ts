/**
 * Sell sheet: the live offer, your share, debt and the score preview; enabled from
 * day 720 (month 24) with a confirm step. DESIGN.md section 12.
 */
import { CONFIG, scorePreview, selectors } from '../../sim';
import type { ShellController } from '../controller';
import { money, percent } from '../format';
import { confirmButton, h, kv, note, section, verdictButton } from './dom';
import type { SheetSpec } from './sheet';

export function sellSheet(controller: ShellController): SheetSpec {
  return {
    id: 'sell',
    title: 'Sell the company',
    render(body, state) {
      const sp = scorePreview(state);
      const from = Math.max(sp.sellFromDay, CONFIG.exit.sellFromDay);
      body.appendChild(section('Offer today',
        kv('Offer (company value)', money(sp.offer), 'big'),
        kv('Your share', percent(sp.founderShare, 1)),
        kv('Debt', money(sp.debt)),
        kv('Score = offer × share', money(sp.score), 'big total')));
      body.appendChild(note(`Investors want ${percent(state.valuation.r, 1)} a year. Tap a HUD pill for the breakdown.`, 'muted'));
      const v = controller.can({ type: 'sell' });
      if (state.day < from) {
        const cal = selectors.calendar(from);
        body.appendChild(note(`Selling opens once month ${Math.round(from / CONFIG.time.daysPerMonth)} closes (day ${from}, end of ${cal.label}). It is ${selectors.calendar(state.day).label} now.`));
        body.appendChild(verdictButton('Sell the company', v.ok ? { ok: false, reason: `Available from ${cal.label}` } : v, () => undefined, 'btn sellbtn'));
      } else if (!v.ok) {
        body.appendChild(verdictButton('Sell the company', v, () => undefined, 'btn sellbtn'));
      } else {
        body.appendChild(confirmButton('Sell the company', `Sell ${state.companyName} for ${money(sp.offer)}? You keep ${money(sp.score)} (${percent(sp.founderShare, 1)}). This ends the run.`, `Sell for ${money(sp.offer)}`, () => {
          controller.dispatch({ type: 'sell' });
        }, 'btn sellbtn'));
      }
      body.appendChild(h('p', { class: 'note muted', text: 'The offer is always the live company value; there is no time limit, so sell when the number is right.' }));
    },
  };
}
