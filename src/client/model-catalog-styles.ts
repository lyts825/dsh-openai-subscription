export const modelCatalogStyles = `
.oa-models { display:flex; flex-direction:column; gap:12px; padding:18px; border:1px solid var(--dsw-alias-border-l2, #e3e5e9); border-radius:12px; color:var(--dsw-alias-label-primary, #1c1d20); font:inherit; }
.oa-models :is(h3,p) { margin:0; }
.oa-models h3 { font-size:14px; font-weight:600; }
.oa-models .oa-models-header { display:flex; gap:12px; justify-content:space-between; align-items:center; flex-wrap:wrap; }
.oa-models .oa-models-muted { color:var(--dsw-alias-label-tertiary, #737782); }
.oa-models .oa-models-meta { display:flex; flex-wrap:wrap; gap:6px 16px; font-size:12px; }
.oa-models .oa-models-search { display:flex; gap:6px; align-items:center; }
.oa-models :is(button,input[type=search]) { box-sizing:border-box; border:1px solid var(--dsw-alias-border-l2, #d5d8df); border-radius:7px; padding:7px 12px; font:inherit; color:inherit; background:var(--dsw-alias-bg-layer-2, Canvas); }
.oa-models input[type=search] { flex:1; min-width:0; width:100%; }
.oa-models input[type=search]::placeholder { color:var(--dsw-alias-label-tertiary, #737782); opacity:1; }
.oa-models button { cursor:pointer; }
.oa-models button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09)); }
.oa-models button:disabled { opacity:.5; cursor:not-allowed; }
.oa-models :is(button,input,summary,[tabindex]):focus-visible { outline:2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset:3px; }
.oa-models .oa-models-results { max-height:380px; overflow:auto; border:1px solid var(--dsw-alias-border-l2, #e3e5e9); border-radius:8px; }
.oa-models ul { margin:0; padding:0; list-style:none; }
.oa-models .oa-models-item { padding:12px; display:flex; flex-direction:column; gap:6px; overflow-wrap:anywhere; }
.oa-models .oa-models-item + .oa-models-item { border-top:1px solid var(--dsw-alias-border-l2, #e3e5e9); }
.oa-models .oa-models-name { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; }
.oa-models code { font-size:12px; font-family:ui-monospace, monospace; overflow-wrap:anywhere; }
.oa-models .oa-models-badge { font-size:11px; border-radius:4px; padding:1px 6px; color:var(--dsw-alias-state-business-primary, #4d6bfe); background:rgba(77,107,254,.09); }
.oa-models .oa-models-upgrade { font-size:12px; }
.oa-models details { font-size:12px; }
.oa-models details p { margin-top:6px; }
.oa-models summary { cursor:pointer; }
.oa-models .oa-models-notice { border-radius:8px; border:1px solid rgba(192,137,38,.25); padding:12px; background:rgba(192,137,38,.1); overflow-wrap:anywhere; }
.oa-models .oa-models-notice details { margin-top:6px; }
`
