// public/js/screens/game/overlays.js — the match-ended plate and the solo pause plate.

import { Button, MicroLabel, html } from '../../ui/components.js';
import { emptyMatch, store } from '../../store.js';
import { localAsset } from '../../data.js';
import { t } from '../../../../shared/i18n.js';

/** The room went back to its lobby without a result (match aborted): offer the way back. */
export function MatchEnded() {
  return html`<div class="awayov" role="dialog" aria-label=${t('模拟已结束')}>
    <div class="awayov__box brackets">
      <${MicroLabel} tone="mint">SIMULATION CLOSED</${MicroLabel}>
      <h2>${t('本局模拟已结束')}</h2>
      <p class="t-lo">${t('同盟已返回等待室')}</p>
      <${Button} variant="primary" size="lg" icon="chevronLeft" onClick=${() => store.set({ match: emptyMatch() })}>${t('返回同盟')}<//>
    </div>
  </div>`;
}

/**
 * 复活队友 (this build, the room extension 'revive'): a just-finished 联防 eliminated a teammate — m.public.reviveAsk
 * asks the survivors whether to rescue it (确认 → g.revive, 暂不复活 → dismiss locally). Shown to every alive viewer but
 * the fallen one; whoever confirms first rescues it (the server clears reviveAsk).
 */
export function ReviveAskOverlay({ ask, name, cost, canAfford, busy, onRevive, onDismiss }) {
  if (!ask) return null;
  return html`<div class="reviveov" role="dialog" aria-modal="true" aria-label=${t('复活队友')} data-testid="revive-ask">
    <div class="reviveov__veil" aria-hidden="true"></div>
    <div class="reviveov__box brackets">
      <${MicroLabel} tone="mint">REVIVE</${MicroLabel}>
      <h2 class="reviveov__title">${t('是否复活队友？')}</h2>
      <p class="reviveov__text">${t('{name} 博士已被淘汰。消耗 {cost} 点目标生命可将其救回——保留干员 / 装备 / 原有状态，恢复至 1 点生命。', { name: name || t('博士'), cost })}</p>
      ${!canAfford ? html`<p class="reviveov__warn">${t('你的目标生命不足（需要 10 点以上），可以让其他队友来救。')}</p>` : null}
      <div class="reviveov__btns">
        <${Button} variant="secondary" size="lg" onClick=${onDismiss}>${t('暂不复活')}<//>
        <${Button} variant="primary" size="lg" icon="check" loading=${busy} disabled=${!canAfford} onClick=${onRevive}>${t('确认复活（消耗 {cost} 点生命）', { cost })}<//>
      </div>
    </div>
  </div>`;
}

/** Solo pause (m.public.paused): the field dims under the 暂停中 plate; 继续作战 resumes (g.pause off). */
export function PausedOverlay({ canResume, busy, onResume, onExit }) {
  const plate = localAsset('ui/battle', 'matte_pause');
  return html`<div class="pauseov" role="dialog" aria-label=${t('暂停中')} data-testid="paused">
    <div class="pauseov__box">
      <div class="pauseov__plate" style=${plate ? `--pause-plate:url("${plate}")` : ''}>
        <span class="pauseov__micro">PAUSED</span>
        <h2>${t('暂停中')}</h2>
      </div>
      <p class="pauseov__note">${t('作战已暂停，计时与敌人行动均已停止')}</p>
      <div class="pauseov__btns">
        ${onExit ? html`<${Button} variant="secondary" size="lg" icon="exit" onClick=${onExit}>${t('放弃模拟')}<//>` : null}
        ${canResume ? html`<${Button} variant="primary" size="lg" icon="play" loading=${busy} onClick=${onResume} data-autofocus>${t('继续作战')}<//>` : null}
      </div>
    </div>
  </div>`;
}
