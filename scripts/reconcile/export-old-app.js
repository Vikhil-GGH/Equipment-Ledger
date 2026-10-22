// READ-ONLY export of the OLD Equipment Ledger app's data.
// How: open the old app (https://vikhil-ggh.github.io/Equipment-Ledger/) in the browser where it was used,
// press F12 > Console, paste this whole file, press Enter. A file "eqledger-export-<date>.json" downloads.
// It only READS localStorage keys that start with "eqledger:". It writes nothing, deletes nothing, sends nothing anywhere.
// Do this in EACH browser/computer where anyone used the old app, BEFORE the cutover (the old site keeps its data per browser).
(() => {
  const data = {}, bad = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith('eqledger:')) continue
    const raw = localStorage.getItem(k)
    try { data[k.slice('eqledger:'.length)] = JSON.parse(raw) } catch (e) { bad.push(k) }
  }
  const out = { format: 'eqledger-localstorage-export-1', exportedAt: new Date().toISOString(), origin: location.origin + location.pathname, unreadableKeys: bad, data }
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]))
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }))
  a.download = 'eqledger-export-' + new Date().toISOString().slice(0, 10) + '.json'
  document.body.appendChild(a); a.click(); a.remove()
  console.log('Exported (read-only):', counts, bad.length ? 'UNREADABLE: ' + bad : '')
})()
