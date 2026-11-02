/**
 * The office floor on canvas: rooms, furniture, people, walking customers, coin popups.
 * DESIGN.md sections 3, 5, 13. STUB — to be implemented.
 */
import type { GameController, OfficeRenderer } from './api';

export function createOfficeRenderer(canvas: HTMLCanvasElement, controller: GameController): OfficeRenderer {
  void controller;
  const ctx = canvas.getContext('2d');
  return {
    resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    },
    frame() {
      if (!ctx) return;
      ctx.fillStyle = '#E8D7BE';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },
    destroy() {},
  };
}
