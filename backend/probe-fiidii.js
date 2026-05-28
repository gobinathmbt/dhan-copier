const http = require('http');
http.get('http://localhost:3000/api/intel-v2/snapshot?symbol=NIFTY_50', (res) => {
  let s = '';
  res.on('data', (d) => (s += d));
  res.on('end', () => {
    const j = JSON.parse(s);
    const fd = j?.macro?.fiiDii;
    if (!fd) { console.log('no fiidii'); return; }
    console.log('date:', fd.date);
    for (const p of ['fii', 'pro', 'client', 'dii']) {
      const f = fd.future?.[p];
      const o = fd.option?.[p];
      console.log(`\n=== ${p.toUpperCase()} ===`);
      console.log('  future.qty.net_oi:', f?.['quantity-wise']?.net_oi, 'view:', f?.['quantity-wise']?.net_view, 'str:', f?.['quantity-wise']?.net_view_strength);
      console.log('  option.call.long.oi_change:', o?.call?.long?.oi_change, ' short.oi_change:', o?.call?.short?.oi_change);
      console.log('  option.call.net_oi:', o?.call?.net_oi, ' net_oi_change:', o?.call?.net_oi_change);
      console.log('  option.put.long.oi_change:', o?.put?.long?.oi_change, ' short.oi_change:', o?.put?.short?.oi_change);
      console.log('  option.put.net_oi:', o?.put?.net_oi, ' net_oi_change:', o?.put?.net_oi_change);
      console.log('  option.overall_view:', o?.overall_net_oi_change_view, 'str:', o?.overall_net_oi_change_view_strength);
    }
  });
});
