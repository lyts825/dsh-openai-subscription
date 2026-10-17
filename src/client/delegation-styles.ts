/** Page-scoped styles, bundled with the client and shared by Web and Desktop. */
export const delegationStyles = `
.dsh-openai-delegation { display:flex; flex-direction:column; gap:18px; max-width:760px; color:var(--dsw-alias-label-primary, #1c1d20); font-size:13px; line-height:1.55; }
.dsh-openai-delegation :is(h2,h3,p) { margin:0; }
.dsh-openai-delegation h2 { font-size:20px; font-weight:650; letter-spacing:-.3px; }
.dsh-openai-delegation h3 { font-size:14px; font-weight:600; }
.dsh-openai-delegation .oa-delegate-heading, .dsh-openai-delegation .oa-delegate-field { display:flex; flex-direction:column; gap:6px; }
.dsh-openai-delegation .oa-delegate-muted { color:var(--dsw-alias-label-tertiary, #737782); }
.dsh-openai-delegation .oa-delegate-card { display:flex; flex-direction:column; gap:18px; padding:18px; border:1px solid var(--dsw-alias-border-l2, #e3e5e9); border-radius:12px; }
.dsh-openai-delegation .oa-delegate-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-openai-delegation .oa-delegate-choice { display:flex; align-items:center; gap:8px; cursor:pointer; }
.dsh-openai-delegation input { accent-color:var(--dsw-alias-state-business-primary, #4d6bfe); }
.dsh-openai-delegation fieldset { padding:0; border:0; margin:0; min-width:0; }
.dsh-openai-delegation legend { padding:0; margin-bottom:8px; font-weight:600; }
.dsh-openai-delegation .oa-delegate-choices { display:flex; gap:22px; flex-wrap:wrap; margin-bottom:8px; }
.dsh-openai-delegation .oa-delegate-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:16px; }
.dsh-openai-delegation button, .dsh-openai-delegation select { box-sizing:border-box; font:inherit; color:inherit; border:1px solid var(--dsw-alias-border-l2, #d5d8df); border-radius:7px; padding:7px 12px; background:transparent; }
.dsh-openai-delegation select { width:100%; max-width:100%; background:var(--dsw-alias-bg-layer-2, Canvas); }
.dsh-openai-delegation button { cursor:pointer; }
.dsh-openai-delegation button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09)); }
.dsh-openai-delegation .oa-delegate-primary { background:var(--dsw-alias-state-business-primary, #4d6bfe); color:white; border-color:transparent; }
.dsh-openai-delegation .oa-delegate-primary:hover:not(:disabled) { background:var(--dsw-alias-state-business-primary, #4d6bfe); filter:brightness(.94); }
.dsh-openai-delegation :disabled { opacity:.5; cursor:not-allowed; }
.dsh-openai-delegation :is(button,select,input,summary):focus-visible { outline:2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset:3px; }
.dsh-openai-delegation .oa-delegate-notice { padding:12px 14px; border-radius:8px; background:rgba(192,137,38,.10); border:1px solid rgba(192,137,38,.25); overflow-wrap:anywhere; }
.dsh-openai-delegation .oa-delegate-success { background:rgba(38,155,105,.09); border-color:rgba(38,155,105,.25); }
.dsh-openai-delegation .oa-delegate-invalid { color:var(--dsw-alias-label-warning, #a9521c); }
.dsh-openai-delegation .oa-delegate-route { font-size:12px; overflow-wrap:anywhere; }
.dsh-openai-delegation details { font-size:12px; margin-top:8px; }
.dsh-openai-delegation summary { cursor:pointer; }
.dsh-openai-delegation pre { margin:8px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }
`
