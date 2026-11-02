// Placeholder entry so the pipeline builds; the UI replaces this file.
import { createGame, advanceTo } from './sim';

const state = createGame(20261102);
advanceTo(state, 60);
const pre = document.createElement('pre');
pre.textContent = JSON.stringify({ day: state.day, cash: state.cash, value: state.valuation.value, history: state.history.length }, null, 2);
document.getElementById('app')!.append(pre);
