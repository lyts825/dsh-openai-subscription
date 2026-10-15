/** Scoped CSS ships inside the plugin bundle, without a second asset request. */
export const styles = `
.dsh-openai-subscription { display:flex; flex-direction:column; gap:20px; max-width:760px; color:var(--dsw-alias-label-primary, #1c1d20); font-size:13px; line-height:1.55; }
.dsh-openai-subscription h2, .dsh-openai-subscription h3, .dsh-openai-subscription p { margin:0; }
.dsh-openai-subscription h2 { font-size:20px; letter-spacing:-.3px; font-weight:650; }
.dsh-openai-subscription h3 { font-size:14px; font-weight:600; }
.dsh-openai-subscription .oa-subtle { color:var(--dsw-alias-label-tertiary, #737782); }
.dsh-openai-subscription .oa-heading { display:flex; flex-direction:column; gap:6px; }
.dsh-openai-subscription .oa-card { padding:18px; border:1px solid var(--dsw-alias-border-l2, #e3e5e9); border-radius:12px; display:flex; flex-direction:column; gap:14px; }
.dsh-openai-subscription .oa-row { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
.dsh-openai-subscription .oa-account { display:flex; flex-direction:column; gap:3px; min-width:0; overflow-wrap:anywhere; }
.dsh-openai-subscription .oa-account strong { font-size:15px; font-weight:600; }
.dsh-openai-subscription .oa-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.dsh-openai-subscription button, .dsh-openai-subscription .oa-link, .dsh-openai-subscription select { font:inherit; color:inherit; border:1px solid var(--dsw-alias-border-l2, #d5d8df); border-radius:7px; background:transparent; padding:7px 12px; }
.dsh-openai-subscription button, .dsh-openai-subscription .oa-link { cursor:pointer; text-decoration:none; }
.dsh-openai-subscription button:hover:not(:disabled), .dsh-openai-subscription .oa-link:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09)); }
.dsh-openai-subscription button:disabled { opacity:.45; cursor:not-allowed; }
.dsh-openai-subscription .oa-primary { background:var(--dsw-alias-state-business-primary, #4d6bfe); color:white; border-color:transparent; }
.dsh-openai-subscription .oa-primary:hover:not(:disabled) { background:var(--dsw-alias-state-business-primary, #4d6bfe); filter:brightness(.94); }
.dsh-openai-subscription :is(button,a,select,summary):focus-visible { outline:2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset:3px; }
.dsh-openai-subscription .oa-notice { padding:12px 14px; border-radius:8px; background:rgba(192,137,38,.10); border:1px solid rgba(192,137,38,.25); display:flex; flex-direction:column; gap:8px; overflow-wrap:anywhere; }
.dsh-openai-subscription .oa-success { background:rgba(38,155,105,.09); border-color:rgba(38,155,105,.25); }
.dsh-openai-subscription .oa-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:12px; }
.dsh-openai-subscription .oa-window { display:flex; flex-direction:column; gap:10px; padding:14px; border-radius:9px; background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.055)); }
.dsh-openai-subscription .oa-window strong { font-weight:600; font-size:13px; }
.dsh-openai-subscription .oa-percent { font-size:20px; letter-spacing:-.5px; font-variant-numeric:tabular-nums; }
.dsh-openai-subscription progress { width:100%; height:5px; appearance:none; border:0; border-radius:5px; overflow:hidden; background:rgba(128,128,128,.16); }
.dsh-openai-subscription progress::-webkit-progress-bar { background:rgba(128,128,128,.16); border-radius:5px; }
.dsh-openai-subscription progress::-webkit-progress-value { background:var(--dsw-alias-state-business-primary, #4d6bfe); border-radius:5px; }
.dsh-openai-subscription progress::-moz-progress-bar { background:var(--dsw-alias-state-business-primary, #4d6bfe); border-radius:5px; }
.dsh-openai-subscription .oa-meta { display:flex; flex-direction:column; gap:3px; font-size:12px; }
.dsh-openai-subscription .oa-bucket { display:flex; flex-direction:column; gap:10px; }
.dsh-openai-subscription .oa-field { display:flex; flex-direction:column; gap:6px; }
.dsh-openai-subscription select { width:100%; max-width:100%; background:var(--dsw-alias-bg-layer-2, Canvas); }
.dsh-openai-subscription .oa-credit-list { margin:0; padding-left:20px; }
.dsh-openai-subscription .oa-credit-list li { margin:5px 0; }
.dsh-openai-subscription .oa-credit-list span { margin-left:8px; }
.dsh-openai-subscription details { font-size:12px; }
.dsh-openai-subscription summary { cursor:pointer; }
.dsh-openai-subscription .oa-error-detail { margin-top:6px; white-space:pre-wrap; font-family:inherit; }
.dsh-openai-subscription dialog { color:inherit; background:var(--dsw-alias-bg-layer-2, Canvas); border:1px solid var(--dsw-alias-border-l2, #e3e5e9); border-radius:14px; padding:24px; width:min(440px, calc(100vw - 40px)); box-sizing:border-box; box-shadow:0 20px 80px rgba(0,0,0,.2); }
.dsh-openai-subscription dialog::backdrop { background:rgba(0,0,0,.32); }
.dsh-openai-subscription .oa-confirm { display:flex; flex-direction:column; gap:16px; }
.dsh-openai-subscription .oa-confirm h3 { font-size:17px; }
.dsh-openai-subscription .oa-confirm .oa-actions { justify-content:flex-end; margin-top:4px; }
@media (prefers-reduced-motion: reduce) { .dsh-openai-subscription * { scroll-behavior:auto; } }
`
