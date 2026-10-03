/* StemForge Admin Panel JS — loaded as external file to avoid browser inline-script caching */

// ── Diagnostic strip ─────────────────────────────────────────
function diagSet(id, ok, msg){
  var el=document.getElementById('diag-'+id);
  if(!el) return;
  el.textContent=(ok?'✅ ':'❌ ')+id+': '+msg;
  el.style.background=ok?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)';
  el.style.color=ok?'#6ee7b7':'#fca5a5';
  el.style.border='1px solid '+(ok?'rgba(16,185,129,.3)':'rgba(239,68,68,.4)');
}
async function runDiag(){
  var diagEl=document.getElementById('admin-diag');
  if(diagEl){ var ts=document.createElement('span'); ts.style.cssText='margin-left:8px;font-size:.75rem;color:#f59e0b'; ts.id='diag-ts'; ts.textContent='running @ '+new Date().toLocaleTimeString(); diagEl.appendChild(ts); }
  ['ping','stats','analytics','revenue','users'].forEach(function(id){
    var el=document.getElementById('diag-'+id);
    if(el){el.textContent=id+'…';el.style.background='#1e293b';el.style.color='#94a3b8';el.style.border='none';}
  });
  // ping
  try{
    var r=await fetch('/api/admin/ping',{credentials:'include'});
    var d=await r.json();
    if(!d.ok) diagSet('ping',false,'ok=false admin='+d.admin+' email='+d.email);
    else if(!d.admin) diagSet('ping',false,'NOT ADMIN — email='+d.email+' plan='+d.plan);
    else diagSet('ping',true,'admin=true email='+d.email);
  }catch(e){ diagSet('ping',false,String(e.message||e)); }
  // stats
  try{
    var r2=await fetch('/api/admin/stats',{credentials:'include'});
    if(!r2.ok){ var t=await r2.text(); diagSet('stats',false,'HTTP '+r2.status+' '+t.slice(0,60)); }
    else{ var d2=await r2.json(); if(d2.error) diagSet('stats',false,d2.error); else diagSet('stats',true,'users='+d2.users.total); }
  }catch(e){ diagSet('stats',false,String(e.message||e)); }
  // analytics
  try{
    var r3=await fetch('/api/admin/analytics',{credentials:'include'});
    if(!r3.ok){ var t3=await r3.text(); diagSet('analytics',false,'HTTP '+r3.status+' '+t3.slice(0,60)); }
    else{ var d3=await r3.json(); if(d3.error) diagSet('analytics',false,d3.error); else diagSet('analytics',true,'today='+d3.today+' month='+d3.month); }
  }catch(e){ diagSet('analytics',false,String(e.message||e)); }
  // revenue
  try{
    var r4=await fetch('/api/admin/revenue',{credentials:'include'});
    if(!r4.ok){ var t4=await r4.text(); diagSet('revenue',false,'HTTP '+r4.status+' '+t4.slice(0,60)); }
    else{ var d4=await r4.json(); if(d4.error) diagSet('revenue',false,d4.error); else diagSet('revenue',true,'mrr=$'+d4.mrr); }
  }catch(e){ diagSet('revenue',false,String(e.message||e)); }
  // users
  try{
    var r5=await fetch('/api/admin/users',{credentials:'include'});
    if(!r5.ok){ var t5=await r5.text(); diagSet('users',false,'HTTP '+r5.status+' '+t5.slice(0,60)); }
    else{ var d5=await r5.json(); if(d5.error) diagSet('users',false,d5.error); else diagSet('users',true,'count='+d5.users.length); }
  }catch(e){ diagSet('users',false,String(e.message||e)); }
}
runDiag();

// ── Stats bar ────────────────────────────────────────────────
(function loadAdminStats(){
  var errEl=document.getElementById('admin-stats-err');
  function showErr(msg){
    if(errEl){ errEl.innerHTML='<b>⚠️ Stats error:</b> '+msg; errEl.style.display='block'; }
    ['stat-users','stat-pro','stat-creator','stat-jobs'].forEach(function(id){ var el=document.getElementById(id); if(el) el.textContent='ERR'; });
  }
  var ctrl=new AbortController(), tid=setTimeout(function(){ ctrl.abort(); showErr('Timed out after 8s'); },8000);
  fetch('/api/admin/stats',{signal:ctrl.signal,credentials:'include'})
    .then(function(res){ clearTimeout(tid); if(!res.ok) return res.text().then(function(t){ throw new Error('HTTP '+res.status+': '+t.slice(0,120)); }); return res.json(); })
    .then(function(data){
      if(data.error) throw new Error(data.error);
      var u=document.getElementById('stat-users'),p=document.getElementById('stat-pro'),cr=document.getElementById('stat-creator');
      if(u)u.textContent=String(data.users?.total||0);
      if(p)p.textContent=String(data.users?.pro_count||0);
      if(cr)cr.textContent=String(data.users?.creator_count||0);
      var j=document.getElementById('stat-jobs'); if(j)j.textContent=String(data.jobs?.total||0);
      if(errEl) errEl.style.display='none';
    })
    .catch(function(e){ showErr(String(e.message||e)); });
})();

var adminTabs=['analytics','revenue','users','signups'];
function adminTab(tab){
  document.querySelectorAll('.admin-tab[data-tab]').forEach(function(t){ t.classList.remove('admin-tab--active'); });
  var btn=document.querySelector('[data-tab="'+tab+'"]'); if(btn) btn.classList.add('admin-tab--active');
  adminTabs.forEach(function(t){ var el=document.getElementById('admin-tab-'+t); if(el) el.style.display=t===tab?'block':'none'; });
  if(tab==='analytics'&&!window._analyticsLoaded){ loadAnalytics(); window._analyticsLoaded=true; }
  if(tab==='revenue'&&!window._revenueLoaded){ loadRevenue(); window._revenueLoaded=true; }
  if(tab==='users'&&!window._usersLoaded){ loadUsers(); window._usersLoaded=true; }
  if(tab==='signups'&&!window._signupsLoaded){ loadSignupClicks(); window._signupsLoaded=true; }
}
loadAnalytics(); window._analyticsLoaded=true;

var SOCIAL_ICONS={tiktok:'<i class="fab fa-tiktok" style="color:#69C9D0"></i>',facebook:'<i class="fab fa-facebook" style="color:#1877F2"></i>',instagram:'<i class="fab fa-instagram" style="color:#E1306C"></i>',youtube:'<i class="fab fa-youtube" style="color:#FF0000"></i>',twitter:'<i class="fab fa-twitter" style="color:#1DA1F2"></i>',snapchat:'<i class="fab fa-snapchat" style="color:#FFFC00"></i>',pinterest:'<i class="fab fa-pinterest" style="color:#E60023"></i>',reddit:'<i class="fab fa-reddit" style="color:#FF4500"></i>',linkedin:'<i class="fab fa-linkedin" style="color:#0A66C2"></i>',google:'<i class="fab fa-google" style="color:#4285F4"></i>',bing:'<i class="fas fa-search" style="color:#008373"></i>',direct:'<i class="fas fa-link" style="color:var(--primary)"></i>',referral:'<i class="fas fa-external-link-alt" style="color:var(--muted)"></i>'};

async function loadAnalytics(){
  var errHtml=function(msg){ return '<p style="color:#fca5a5;font-size:.82rem;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><b>❌ Error:</b> '+msg+'</p>'; };
  try{
    var ctrl=new AbortController(),tid=setTimeout(function(){ctrl.abort();},10000);
    var res=await fetch('/api/admin/analytics',{signal:ctrl.signal,credentials:'include'});
    clearTimeout(tid);
    if(!res.ok){ var errTxt=await res.text(); throw new Error('HTTP '+res.status+': '+errTxt.slice(0,120)); }
    var d=await res.json(); if(d.error) throw new Error(d.error);
    document.getElementById('an-today').textContent=d.today||0;
    document.getElementById('an-week').textContent=d.week||0;
    document.getElementById('an-month').textContent=d.month||0;
    // Busy errors stat
    var busyEl=document.getElementById('an-busy-30d');
    var busyTodayEl=document.getElementById('an-busy-today');
    if(busyEl){
      var b30=d.busy_errors_30d||0;
      busyEl.textContent=b30;
      busyEl.style.color=b30>0?'#f59e0b':'';
    }
    if(busyTodayEl){
      var bToday=d.busy_errors_today||0;
      busyTodayEl.textContent='today: '+bToday;
      busyTodayEl.style.color=bToday>0?'#fbbf24':'';
      busyTodayEl.style.display='block';
      // Show breakdown by type if data exists
      var byType=d.busy_errors_by_type||[];
      if(byType.length>1){
        var parts=byType.map(function(t){ return t.error_type.replace('_busy','').replace('musicapi','MusicAPI').replace('mureka','Mureka')+': '+t.cnt; });
        busyTodayEl.textContent='today: '+bToday+' ('+parts.join(', ')+')';
      }
    }
    var daily=d.daily||[],chartEl=document.getElementById('daily-chart');
    if(!daily.length){ chartEl.innerHTML='<p style="color:var(--muted);font-size:.82rem;text-align:center;width:100%">No data yet</p>'; }
    else {
      // ── Professional SVG area line chart ──────────────────────
      var W=chartEl.offsetWidth||560, H=160, PAD={top:12,right:16,bottom:40,left:36};
      var cW=W-PAD.left-PAD.right, cH=H-PAD.top-PAD.bottom;
      var vals=daily.map(function(r){return r.cnt||0;});
      var maxV=Math.max.apply(null,vals.concat([1]));
      var minV=0;
      // X positions
      var xStep=cW/(daily.length-1||1);
      var pts=daily.map(function(r,i){
        var x=PAD.left+i*xStep;
        var y=PAD.top+cH-Math.round(((r.cnt-minV)/(maxV-minV))*cH);
        return {x:x,y:y,cnt:r.cnt,lbl:new Date(r.day_bucket*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric'})};
      });
      // Build smooth polyline points
      var linePoints=pts.map(function(p){return p.x+','+p.y;}).join(' ');
      // Area fill polygon (line + bottom edge)
      var areaPoints=linePoints+' '+pts[pts.length-1].x+','+(PAD.top+cH)+' '+pts[0].x+','+(PAD.top+cH);
      // Y axis grid lines & labels (4 levels)
      var gridLines='';
      for(var gi=0;gi<=4;gi++){
        var gy=PAD.top+cH-Math.round((gi/4)*cH);
        var gv=Math.round((gi/4)*maxV);
        gridLines+='<line x1="'+PAD.left+'" y1="'+gy+'" x2="'+(W-PAD.right)+'" y2="'+gy+'" stroke="rgba(255,255,255,.06)" stroke-width="1"/>';
        gridLines+='<text x="'+(PAD.left-6)+'" y="'+(gy+4)+'" text-anchor="end" fill="rgba(148,163,184,.6)" font-size="10">'+gv+'</text>';
      }
      // X axis labels — show every Nth label to avoid overlap
      var labelEvery=Math.ceil(daily.length/8);
      var xLabels=pts.map(function(p,i){
        if(i%labelEvery!==0 && i!==daily.length-1) return '';
        return '<text x="'+p.x+'" y="'+(H-6)+'" text-anchor="middle" fill="rgba(148,163,184,.7)" font-size="10">'+p.lbl+'</text>';
      }).join('');
      // Tooltip dots (invisible, revealed on hover via title)
      var dots=pts.map(function(p){
        return '<circle cx="'+p.x+'" cy="'+p.y+'" r="4" fill="#4e9fff" stroke="#0f172a" stroke-width="2" opacity="0" style="cursor:pointer" onmouseenter="this.setAttribute(\'opacity\',\'1\');document.getElementById(\'chart-tip\').style.display=\'block\';document.getElementById(\'chart-tip\').style.left=\''+'\'+(this.cx.baseVal.value+8)+\'px\';document.getElementById(\'chart-tip\').textContent=\''+p.lbl+': '+p.cnt+' views\';" onmouseleave="this.setAttribute(\'opacity\',\'0\');document.getElementById(\'chart-tip\').style.display=\'none\'"><title>'+p.lbl+': '+p.cnt+' views</title></circle>';
      }).join('');
      chartEl.style.height='auto';
      chartEl.style.display='block';
      chartEl.style.position='relative';
      chartEl.innerHTML=
        '<div id="chart-tip" style="display:none;position:absolute;background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:.75rem;padding:4px 10px;border-radius:6px;pointer-events:none;white-space:nowrap;z-index:10"></div>'+
        '<svg width="100%" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">'+
          '<defs>'+
            '<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">'+
              '<stop offset="0%" stop-color="#4e9fff" stop-opacity="0.25"/>'+
              '<stop offset="100%" stop-color="#4e9fff" stop-opacity="0.02"/>'+
            '</linearGradient>'+
          '</defs>'+
          gridLines+
          '<polygon points="'+areaPoints+'" fill="url(#areaGrad)"/>'+
          '<polyline points="'+linePoints+'" fill="none" stroke="#4e9fff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+
          dots+
          xLabels+
        '</svg>';
    }
    var sources=d.sources||[],totalSrc=sources.reduce(function(a,s){return a+s.cnt;},0)||1,srcEl=document.getElementById('sources-chart');
    if(!sources.length){ srcEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No traffic data yet</p>'; }
    else { srcEl.innerHTML=sources.map(function(s){ var pct=Math.round((s.cnt/totalSrc)*100),icon=SOCIAL_ICONS[s.source||'direct']||SOCIAL_ICONS.referral,name=s.source||'direct'; return '<div class="rv-bar-wrap" style="margin-bottom:10px"><div style="width:22px;text-align:center">'+icon+'</div><div style="width:80px;font-size:.82rem;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+name+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:var(--primary)"></div></div><div style="width:36px;text-align:right;font-size:.82rem;font-weight:700">'+s.cnt+'</div><div style="width:34px;text-align:right;font-size:.75rem;color:var(--muted)">'+pct+'%</div></div>'; }).join(''); }
    var socialKeys=['tiktok','facebook','instagram','youtube','twitter','snapchat','pinterest','reddit','linkedin'],srcMap={};
    (d.sources||[]).forEach(function(s){srcMap[s.source]=s.cnt;});
    document.getElementById('social-breakdown').innerHTML=socialKeys.map(function(k){ var cnt=srcMap[k]||0; return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-size:1.4rem;margin-bottom:6px">'+(SOCIAL_ICONS[k]||'')+'</div><div style="font-size:1.1rem;font-weight:700">'+cnt+'</div><div style="font-size:.72rem;color:var(--muted);text-transform:capitalize;margin-top:2px">'+k+'</div></div>'; }).join('');
    var pages=d.top_pages||[],pgEl=document.getElementById('top-pages');
    if(!pages.length){ pgEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No data yet</p>'; }
    else { var maxPg=Math.max.apply(null,pages.map(function(p){return p.cnt;}).concat([1])); pgEl.innerHTML='<table class="admin-table"><thead><tr><th>Page</th><th>Views</th><th style="width:200px">Share</th></tr></thead><tbody>'+pages.map(function(p){ var pct=Math.round((p.cnt/maxPg)*100); return '<tr><td><code style="font-size:.85rem">'+p.path+'</code></td><td style="font-weight:700">'+p.cnt+'</td><td><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:#a78bfa"></div></div></td></tr>'; }).join('')+'</tbody></table>'; }
    // ── Countries chart ───────────────────────────────────────────
    var COUNTRY_NAMES={AF:'Afghanistan',AL:'Albania',DZ:'Algeria',AD:'Andorra',AO:'Angola',AG:'Antigua & Barbuda',AR:'Argentina',AM:'Armenia',AU:'Australia',AT:'Austria',AZ:'Azerbaijan',BS:'Bahamas',BH:'Bahrain',BD:'Bangladesh',BB:'Barbados',BY:'Belarus',BE:'Belgium',BZ:'Belize',BJ:'Benin',BT:'Bhutan',BO:'Bolivia',BA:'Bosnia & Herzegovina',BW:'Botswana',BR:'Brazil',BN:'Brunei',BG:'Bulgaria',BF:'Burkina Faso',BI:'Burundi',CV:'Cabo Verde',KH:'Cambodia',CM:'Cameroon',CA:'Canada',CF:'Central African Republic',TD:'Chad',CL:'Chile',CN:'China',CO:'Colombia',KM:'Comoros',CG:'Congo',CD:'DR Congo',CR:'Costa Rica',HR:'Croatia',CU:'Cuba',CY:'Cyprus',CZ:'Czech Republic',DK:'Denmark',DJ:'Djibouti',DM:'Dominica',DO:'Dominican Republic',EC:'Ecuador',EG:'Egypt',SV:'El Salvador',GQ:'Equatorial Guinea',ER:'Eritrea',EE:'Estonia',SZ:'Eswatini',ET:'Ethiopia',FJ:'Fiji',FI:'Finland',FR:'France',GA:'Gabon',GM:'Gambia',GE:'Georgia',DE:'Germany',GH:'Ghana',GR:'Greece',GD:'Grenada',GT:'Guatemala',GN:'Guinea',GW:'Guinea-Bissau',GY:'Guyana',HT:'Haiti',HN:'Honduras',HU:'Hungary',IS:'Iceland',IN:'India',ID:'Indonesia',IR:'Iran',IQ:'Iraq',IE:'Ireland',IL:'Israel',IT:'Italy',JM:'Jamaica',JP:'Japan',JO:'Jordan',KZ:'Kazakhstan',KE:'Kenya',KI:'Kiribati',KW:'Kuwait',KG:'Kyrgyzstan',LA:'Laos',LV:'Latvia',LB:'Lebanon',LS:'Lesotho',LR:'Liberia',LY:'Libya',LI:'Liechtenstein',LT:'Lithuania',LU:'Luxembourg',MG:'Madagascar',MW:'Malawi',MY:'Malaysia',MV:'Maldives',ML:'Mali',MT:'Malta',MH:'Marshall Islands',MR:'Mauritania',MU:'Mauritius',MX:'Mexico',FM:'Micronesia',MD:'Moldova',MC:'Monaco',MN:'Mongolia',ME:'Montenegro',MA:'Morocco',MZ:'Mozambique',MM:'Myanmar',NA:'Namibia',NR:'Nauru',NP:'Nepal',NL:'Netherlands',NZ:'New Zealand',NI:'Nicaragua',NE:'Niger',NG:'Nigeria',MK:'North Macedonia',NO:'Norway',OM:'Oman',PK:'Pakistan',PW:'Palau',PA:'Panama',PG:'Papua New Guinea',PY:'Paraguay',PE:'Peru',PH:'Philippines',PL:'Poland',PT:'Portugal',QA:'Qatar',RO:'Romania',RU:'Russia',RW:'Rwanda',KN:'Saint Kitts & Nevis',LC:'Saint Lucia',VC:'Saint Vincent',WS:'Samoa',SM:'San Marino',ST:'São Tomé & Príncipe',SA:'Saudi Arabia',SN:'Senegal',RS:'Serbia',SC:'Seychelles',SL:'Sierra Leone',SG:'Singapore',SK:'Slovakia',SI:'Slovenia',SB:'Solomon Islands',SO:'Somalia',ZA:'South Africa',SS:'South Sudan',ES:'Spain',LK:'Sri Lanka',SD:'Sudan',SR:'Suriname',SE:'Sweden',CH:'Switzerland',SY:'Syria',TW:'Taiwan',TJ:'Tajikistan',TZ:'Tanzania',TH:'Thailand',TL:'Timor-Leste',TG:'Togo',TO:'Tonga',TT:'Trinidad & Tobago',TN:'Tunisia',TR:'Turkey',TM:'Turkmenistan',TV:'Tuvalu',UG:'Uganda',UA:'Ukraine',AE:'UAE',GB:'United Kingdom',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',VU:'Vanuatu',VE:'Venezuela',VN:'Vietnam',YE:'Yemen',ZM:'Zambia',ZW:'Zimbabwe',T1:'Tor/VPN',XX:'Unknown'};
    var countries=d.countries||[],ccEl=document.getElementById('countries-chart');
    if(ccEl){
      if(!countries.length){ ccEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No country data yet — will populate on next page view</p>'; }
      else {
        var totalCC=countries.reduce(function(a,c){return a+(c.cnt||0);},0)||1;
        var maxCC=countries[0].cnt||1;
        ccEl.innerHTML='<table class="admin-table"><thead><tr><th style="width:32px"></th><th>Country</th><th style="width:60px">Views</th><th style="width:220px">Share</th></tr></thead><tbody>'+
          countries.map(function(c){
            var flag=c.country && c.country.length===2 ? String.fromCodePoint(0x1F1E6+c.country.charCodeAt(0)-65)+String.fromCodePoint(0x1F1E6+c.country.charCodeAt(1)-65) : '🌐';
            var name=COUNTRY_NAMES[c.country]||c.country||'Unknown';
            var pct=Math.round((c.cnt/maxCC)*100);
            var share=((c.cnt/totalCC)*100).toFixed(1);
            return '<tr><td style="font-size:1.2rem;text-align:center;padding:6px 4px">'+flag+'</td>'+
              '<td style="font-size:.88rem">'+name+'</td>'+
              '<td style="font-weight:700;text-align:right">'+c.cnt+'</td>'+
              '<td><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:#34d399"></div></div><span style="font-size:.72rem;color:var(--muted);margin-left:6px">'+share+'%</span></td></tr>';
          }).join('')+
        '</tbody></table>';
      }
    }
  }catch(e){
    var msg=String(e.message||e);
    var eh=errHtml(msg);
    var dc=document.getElementById('daily-chart'); if(dc) dc.innerHTML=eh;
    var sc=document.getElementById('sources-chart'); if(sc) sc.innerHTML=eh;
    var sb=document.getElementById('social-breakdown'); if(sb) sb.innerHTML='<div style="grid-column:1/-1">'+eh+'</div>';
    var tp=document.getElementById('top-pages'); if(tp) tp.innerHTML=eh;
    document.getElementById('an-today').textContent='ERR';
    document.getElementById('an-week').textContent='ERR';
    document.getElementById('an-month').textContent='ERR';
    var be=document.getElementById('an-busy-30d'); if(be) be.textContent='ERR';
    var ce=document.getElementById('countries-chart'); if(ce) ce.innerHTML=eh;
  }
}

async function loadRevenue(){
  try{
    var res=await fetch('/api/admin/revenue',{credentials:'include'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    var d=await res.json(); if(d.error) throw new Error(d.error);
    var mrr=d.mrr||0;
    document.getElementById('rv-mrr').textContent='$'+mrr.toLocaleString();
    document.getElementById('rv-pro').textContent=d.pro_count||0;
    document.getElementById('rv-creator').textContent=d.creator_count||0;
    document.getElementById('rv-free').textContent=d.free_count||0;
    document.getElementById('stat-mrr').textContent='$'+mrr;
    document.getElementById('rv-pl-mrr').textContent='$'+mrr.toLocaleString();
    document.getElementById('rv-pl-credits').textContent=d.credit_pack_revenue?'$'+parseFloat(d.credit_pack_revenue).toFixed(2):'$0';
    document.getElementById('rv-pl-musicapi').textContent='-$'+(d.estimated_musicapi_cost||0).toFixed(2)+' ('+(d.jobs_this_month||0)+' jobs)';
    var profit=d.estimated_profit||0,profitEl=document.getElementById('rv-pl-profit');
    profitEl.textContent=(profit>=0?'+':'')+'$'+profit.toFixed(2); profitEl.style.color=profit>=0?'#10b981':'#ef4444';
    var total=mrr+(d.credit_pack_revenue||0),pieEl=document.getElementById('rv-pie');
    if(!total){ pieEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No revenue yet</p>'; }
    else { var rows=[{label:'Pro Artist ('+(d.pro_count||0)+'x$26)',val:(d.pro_count||0)*26,color:'#a78bfa'},{label:'Creator ('+(d.creator_count||0)+'x$10)',val:(d.creator_count||0)*10,color:'#3b82f6'},{label:'Credit Packs',val:d.credit_pack_revenue||0,color:'#f59e0b'}]; pieEl.innerHTML=rows.map(function(r){ var pct=total>0?Math.round((r.val/total)*100):0; return '<div class="rv-bar-wrap" style="margin-bottom:12px"><div style="width:12px;height:12px;border-radius:3px;background:'+r.color+';flex-shrink:0"></div><div style="flex:1;font-size:.85rem">'+r.label+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:'+r.color+'"></div></div><div style="width:52px;text-align:right;font-size:.85rem;font-weight:700">$'+r.val+'</div></div>'; }).join(''); }
    var subs=d.recent_subscribers||[],subsEl=document.getElementById('rv-subs');
    if(!subs.length){ subsEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No paid subscribers yet.</p>'; }
    else { subsEl.innerHTML='<table class="admin-table"><thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Joined</th></tr></thead><tbody>'+subs.map(function(s){ return '<tr><td>'+s.email+'</td><td>'+s.name+'</td><td><span class="plan-badge plan-badge--'+s.plan+'">'+s.plan+'</span></td><td>'+new Date(s.created_at).toLocaleDateString()+'</td></tr>'; }).join('')+'</tbody></table>'; }
  }catch(e){
    var msg=String(e.message||e);
    var eh='<p style="color:#fca5a5;font-size:.82rem;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><b>❌ Error:</b> '+msg+'</p>';
    document.getElementById('rv-mrr').textContent='ERR';
    var pie=document.getElementById('rv-pie'); if(pie) pie.innerHTML=eh;
    var subs=document.getElementById('rv-subs'); if(subs) subs.innerHTML=eh;
  }
}

var _userSearchTimeout=null;
function initUserSearch(){
  var wrap=document.getElementById('admin-users-list');
  if(!wrap||document.getElementById('admin-user-search')) return;
  var bar='<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">'+
    '<div style="position:relative;flex:1;max-width:360px">'+
      '<i class="fas fa-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.85rem"></i>'+
      '<input id="admin-user-search" type="text" placeholder="Search by email or name…" '+
        'style="width:100%;padding:9px 12px 9px 32px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:.88rem;box-sizing:border-box"'+
        ' oninput="onUserSearch(this.value)"/>'+
    '</div>'+
    '<span id="admin-user-count" style="font-size:.82rem;color:var(--muted)"></span>'+
  '</div>'+
  '<div id="admin-users-table"></div>';
  wrap.innerHTML=bar;
}
function onUserSearch(q){
  clearTimeout(_userSearchTimeout);
  _userSearchTimeout=setTimeout(function(){ loadUsers(q); },320);
}

async function loadUsers(q){
  initUserSearch();
  var tableEl=document.getElementById('admin-users-table');
  var countEl=document.getElementById('admin-user-count');
  if(!tableEl) return;
  tableEl.innerHTML='<p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  try{
    var url='/api/admin/users'+(q?'?q='+encodeURIComponent(q):'');
    var ctrl=new AbortController(),tid=setTimeout(function(){ctrl.abort();},12000);
    var res=await fetch(url,{signal:ctrl.signal,credentials:'include'});
    clearTimeout(tid);
    var data=await res.json();
    if(data.error){ tableEl.innerHTML='<p style="color:#ef4444">Error: '+data.error+'</p>'; return; }
    if(!data.users||!data.users.length){ tableEl.innerHTML='<p style="color:var(--muted)">No users found.</p>'; return; }
    if(countEl) countEl.textContent=data.users.length+' user'+(data.users.length!==1?'s':'');
    tableEl.innerHTML='<div style="overflow-x:auto"><table class="admin-table"><thead><tr>'+
      '<th>Email / Name</th><th>Plan</th><th>Status</th>'+
      '<th>Points</th><th>Bonus</th>'+
      '<th>Signed Up</th><th>Renewal</th><th>Actions</th>'+
    '</tr></thead><tbody id="admin-users-tbody">'+
      data.users.map(function(u){
        var rem=Math.max(0,(u.gens_limit||0)-(u.gens_used||0));
        var remColor=rem===0?'#ef4444':rem<=(u.gens_limit*0.1)?'#f59e0b':'#10b981';
        var bonus=u.bonus_credits||0;
        var isLocked=u.account_locked===1;
        var lockBadge=isLocked
          ?'<span style="background:#7f1d1d;color:#fca5a5;font-size:.65rem;padding:2px 7px;border-radius:999px;font-weight:700;border:1px solid rgba(239,68,68,.3)">LOCKED</span>'
          :'<span style="color:#10b981;font-size:.75rem">Active</span>';
        var signupDate=u.created_at?new Date(u.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';
        var hasSub=!!u.stripe_subscription_id;
        var renewalCell;
        if(hasSub){
          renewalCell='<span id="renew-'+u.id+'" style="color:var(--muted);font-size:.78rem" data-user-id="'+u.id+'" data-loaded="0">Loading…</span>';
        } else if(u.plan==='free' && u.cycle_start){
          // Free plan — show next reset date (cycle_start + 30 days)
          var nextReset=new Date(u.cycle_start + 30*24*60*60*1000);
          var nextResetStr=nextReset.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
          var nowMs=Date.now();
          var daysLeft=Math.max(0,Math.ceil((nextReset.getTime()-nowMs)/(24*60*60*1000)));
          var badge=daysLeft<=3?'<span style="background:rgba(245,158,11,.15);color:#f59e0b;font-size:.65rem;padding:1px 6px;border-radius:999px;margin-left:4px">'+daysLeft+'d left</span>':'';
          renewalCell='<span style="color:#94a3b8;font-size:.78rem" title="Free plan resets every 30 days">'+nextResetStr+badge+'</span>';
        } else {
          renewalCell='<span style="color:var(--muted);font-size:.78rem">—</span>';
        }
        return '<tr data-uid="'+u.id+'" style="'+(isLocked?'background:rgba(239,68,68,.04)':'')+'">'+
          '<td><div style="font-weight:600;font-size:.85rem">'+u.email+'</div><div style="color:var(--muted);font-size:.78rem">'+u.name+'</div></td>'+
          '<td><span class="plan-badge plan-badge--'+u.plan+'">'+u.plan+'</span></td>'+
          '<td>'+lockBadge+'</td>'+
          '<td style="color:'+remColor+';font-weight:700">'+rem+'<small style="font-weight:400;color:var(--muted)"> / '+u.gens_limit+'</small></td>'+
          '<td style="color:'+(bonus>0?'#a78bfa':'var(--muted)')+';font-weight:700">'+(bonus>0?'+'+bonus:'—')+'</td>'+
          '<td style="font-size:.78rem;color:var(--muted)">'+signupDate+'</td>'+
          '<td style="font-size:.78rem">'+renewalCell+'</td>'+
          '<td><div style="display:flex;gap:4px;flex-wrap:wrap">'+
            '<button onclick="changeUserPlan(\''+u.id+'\',\''+u.email+'\')" class="btn btn--outline btn--sm" style="font-size:.72rem;padding:4px 8px">Plan</button>'+
            '<button onclick="addCredits(\''+u.id+'\',\''+u.email+'\')" class="btn btn--outline btn--sm" style="font-size:.72rem;padding:4px 8px">+Pts</button>'+
            '<button onclick="toggleLockUser(\''+u.id+'\',\''+u.email+'\','+(isLocked?1:0)+')" class="btn btn--sm" style="font-size:.72rem;padding:4px 8px;background:'+(isLocked?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)')+';border:1px solid '+(isLocked?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)')+';color:'+(isLocked?'#10b981':'#ef4444')+'">'+(isLocked?'Unlock':'Lock')+'</button>'+
            '<button onclick="deleteUserAccount(\''+u.id+'\',\''+u.email+'\')" class="btn btn--sm" style="font-size:.72rem;padding:4px 8px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444"><i class="fas fa-trash"></i></button>'+
          '</div></td>'+
        '</tr>';
      }).join('')+'</tbody></table></div>';
    // Lazy-load renewal dates for users with subscriptions
    data.users.filter(function(u){ return !!u.stripe_subscription_id; }).forEach(function(u){
      fetch('/api/admin/user-renewal/'+u.id,{credentials:'include'})
        .then(function(r){ return r.json(); })
        .then(function(d){
          var el=document.getElementById('renew-'+u.id);
          if(el) el.textContent=d.renewal_date||'—';
        }).catch(function(){
          var el=document.getElementById('renew-'+u.id);
          if(el) el.textContent='—';
        });
    });
    window._usersLoaded=true;
  }catch(e){ if(tableEl) tableEl.innerHTML='<p style="color:#ef4444"><i class="fas fa-exclamation-circle"></i> Failed to load: '+(e.message||'timeout')+'</p>'; }
}

// ── Signup Clicks Tab ────────────────────────────────────────
async function loadSignupClicks(){
  var errHtml=function(msg){ return '<p style="color:#fca5a5;font-size:.82rem;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><b>\u274c Error:</b> '+msg+'</p>'; };
  try{
    var res=await fetch('/api/admin/signup-clicks',{credentials:'include'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    var d=await res.json(); if(d.error) throw new Error(d.error);
    var s=d.stats||{};
    var todayEl=document.getElementById('sc-today'); if(todayEl) todayEl.textContent=s.today||0;
    var weekEl=document.getElementById('sc-week'); if(weekEl) weekEl.textContent=s.this_week||0;
    var g30El=document.getElementById('sc-google30'); if(g30El) g30El.textContent=s.google_30d||0;
    var e30El=document.getElementById('sc-email30'); if(e30El) e30El.textContent=s.email_30d||0;

    // ── Daily trend chart ───────────────────────────────────
    var chartEl=document.getElementById('sc-daily-chart');
    if(chartEl){
      var daily=d.daily||[];
      if(!daily.length){ chartEl.innerHTML='<p style="color:var(--muted);font-size:.82rem;text-align:center;padding-top:40px">No data yet</p>'; }
      else {
        // Merge rows by day: google + email each get own array
        var dayMap={};
        daily.forEach(function(r){ var day=r.day; if(!dayMap[day]) dayMap[day]={day:day,google:0,email:0}; dayMap[day][r.event_type]=(dayMap[day][r.event_type]||0)+r.cnt; });
        var days=Object.keys(dayMap).sort();
        var googleVals=days.map(function(d){ return dayMap[d].google||0; });
        var emailVals=days.map(function(d){ return dayMap[d].email||0; });
        var maxV=Math.max.apply(null,days.map(function(d){ return dayMap[d].google+dayMap[d].email; }).concat([1]));
        var W=chartEl.offsetWidth||560, H=160, PAD={top:12,right:16,bottom:40,left:36};
        var cW=W-PAD.left-PAD.right, cH=H-PAD.top-PAD.bottom;
        var xStep=cW/(days.length-1||1);
        // Grid lines
        var gridLines='';
        for(var gi=0;gi<=4;gi++){
          var gy=PAD.top+cH-Math.round((gi/4)*cH);
          var gv=Math.round((gi/4)*maxV);
          gridLines+='<line x1="'+PAD.left+'" y1="'+gy+'" x2="'+(W-PAD.right)+'" y2="'+gy+'" stroke="rgba(255,255,255,.06)" stroke-width="1"/>';
          gridLines+='<text x="'+(PAD.left-6)+'" y="'+(gy+4)+'" text-anchor="end" fill="rgba(148,163,184,.6)" font-size="10">'+gv+'</text>';
        }
        // Google line (blue)
        var gPts=days.map(function(day,i){ var x=PAD.left+i*xStep; var v=dayMap[day].google||0; var y=PAD.top+cH-Math.round((v/maxV)*cH); return {x:x,y:y,cnt:v,lbl:day}; });
        var gLine=gPts.map(function(p){return p.x+','+p.y;}).join(' ');
        var gArea=gLine+' '+gPts[gPts.length-1].x+','+(PAD.top+cH)+' '+gPts[0].x+','+(PAD.top+cH);
        // Email line (amber)
        var ePts=days.map(function(day,i){ var x=PAD.left+i*xStep; var v=dayMap[day].email||0; var y=PAD.top+cH-Math.round((v/maxV)*cH); return {x:x,y:y,cnt:v,lbl:day}; });
        var eLine=ePts.map(function(p){return p.x+','+p.y;}).join(' ');
        // X labels
        var labelEvery=Math.ceil(days.length/8);
        var xLabels=days.map(function(day,i){ if(i%labelEvery!==0 && i!==days.length-1) return ''; return '<text x="'+(PAD.left+i*xStep)+'" y="'+(H-6)+'" text-anchor="middle" fill="rgba(148,163,184,.7)" font-size="10">'+day.slice(5)+'</text>'; }).join('');
        chartEl.style.height='auto'; chartEl.style.display='block'; chartEl.style.position='relative';
        chartEl.innerHTML=
          '<div style="display:flex;gap:16px;margin-bottom:8px;font-size:.75rem;">'+
            '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#4285F4;margin-right:4px"></span>Google</span>'+
            '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f59e0b;margin-right:4px"></span>Email</span>'+
          '</div>'+
          '<svg width="100%" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">'+
            '<defs>'+
              '<linearGradient id="gAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4285F4" stop-opacity="0.2"/><stop offset="100%" stop-color="#4285F4" stop-opacity="0.01"/></linearGradient>'+
            '</defs>'+
            gridLines+
            '<polygon points="'+gArea+'" fill="url(#gAreaGrad)"/>'+
            '<polyline points="'+gLine+'" fill="none" stroke="#4285F4" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+
            '<polyline points="'+eLine+'" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="5,3"/>'+
            xLabels+
          '</svg>';
      }
    }

    // ── Breakdown pie bars ──────────────────────────────────
    var bkEl=document.getElementById('sc-breakdown');
    if(bkEl){
      var total=(s.google_30d||0)+(s.email_30d||0);
      if(!total){ bkEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No clicks recorded yet.</p>'; }
      else {
        var rows2=[
          {label:'Google Sign-up',cnt:s.google_30d||0,color:'#4285F4',icon:'fab fa-google'},
          {label:'Email Sign-up',cnt:s.email_30d||0,color:'#f59e0b',icon:'fas fa-envelope'},
        ];
        bkEl.innerHTML=rows2.map(function(r){ var pct=total>0?Math.round((r.cnt/total)*100):0; return '<div class="rv-bar-wrap" style="margin-bottom:14px"><div style="width:24px;text-align:center"><i class="'+r.icon+'" style="color:'+r.color+'"></i></div><div style="width:110px;font-size:.84rem">'+r.label+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:'+r.color+'"></div></div><div style="width:36px;text-align:right;font-size:.85rem;font-weight:700">'+r.cnt+'</div><div style="width:40px;text-align:right;font-size:.75rem;color:var(--muted)">'+pct+'%</div></div>'; }).join(''); }
    }

    // ── Recent events table ──────────────────────────────────
    var recEl=document.getElementById('sc-recent');
    if(recEl){
      var recent=d.recent||[];
      if(!recent.length){ recEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No click events yet.</p>'; }
      else {
        recEl.innerHTML='<table class="admin-table"><thead><tr><th>Type</th><th>Page</th><th>Country</th><th>Referrer</th><th>Time</th></tr></thead><tbody>'+
          recent.map(function(r){
            var typeIcon=r.event_type==='google'
              ?'<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(66,133,244,.15);color:#4285F4;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600"><i class="fab fa-google"></i> Google</span>'
              :'<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(245,158,11,.15);color:#f59e0b;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600"><i class="fas fa-envelope"></i> Email</span>';
            var flag=r.country && r.country.length===2
              ?String.fromCodePoint(0x1F1E6+r.country.charCodeAt(0)-65)+String.fromCodePoint(0x1F1E6+r.country.charCodeAt(1)-65)+' '
              :'\uD83C\uDF10 ';
            var ref=r.referrer?('<code style="font-size:.75rem;max-width:180px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle" title="'+r.referrer+'">'+r.referrer.replace(/^https?:\/\//,'').slice(0,40)+'</code>'):'<span style="color:var(--muted);font-size:.78rem">direct</span>';
            var ts=new Date(r.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
            return '<tr><td>'+typeIcon+'</td><td style="font-size:.82rem;color:var(--muted)">'+r.page+'</td><td style="font-size:.85rem">'+flag+(r.country||'?')+'</td><td>'+ref+'</td><td style="font-size:.78rem;color:var(--muted);white-space:nowrap">'+ts+'</td></tr>';
          }).join('')+
        '</tbody></table>';
      }
    }

    window._signupsLoaded=true;
  }catch(e){
    var msg=String(e.message||e);
    var eh=errHtml(msg);
    var dc2=document.getElementById('sc-daily-chart'); if(dc2) dc2.innerHTML=eh;
    var bk=document.getElementById('sc-breakdown'); if(bk) bk.innerHTML=eh;
    var rc=document.getElementById('sc-recent'); if(rc) rc.innerHTML=eh;
  }
}

async function toggleLockUser(userId,email,currentlyLocked){
  var lock=!currentlyLocked,reason='';
  if(lock){ reason=prompt('Reason for locking "'+email+'" (shown to user):','Multiple accounts detected. Only one free account per household.'); if(reason===null)return; }
  else { if(!confirm('Unlock account for "'+email+'"?'))return; }
  var res=await fetch('/api/admin/user/lock',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({user_id:userId,locked:lock,reason:reason})});
  var data=await res.json(); if(data.ok){ window._usersLoaded=false; loadUsers(); } else { alert('Error: '+(data.error||'Failed')); }
}

async function deleteUserAccount(userId,email){
  if(!confirm('Delete account for "'+email+'"? This cannot be undone.')) return;
  if(!confirm('Are you absolutely sure? Permanent.')) return;
  var res=await fetch('/api/admin/user/'+userId,{method:'DELETE',credentials:'include'});
  var data=await res.json(); if(data.ok){ window._usersLoaded=false; loadUsers(); alert('Account deleted.'); } else { alert('Error: '+(data.error||'Failed')); }
}

function changeUserPlan(userId,email){
  document.getElementById('umod-title').textContent='Edit Plan — '+email;
  document.getElementById('umod-plan-section').style.display='';
  document.getElementById('umod-credits-section').style.display='none';
  document.getElementById('umod-user-id').value=userId;
  document.getElementById('umod-overlay').style.display='flex';
  document.getElementById('umod-plan').focus();
}

function addCredits(userId,email){
  document.getElementById('umod-title').textContent='+Credits — '+email;
  document.getElementById('umod-plan-section').style.display='none';
  document.getElementById('umod-credits-section').style.display='';
  document.getElementById('umod-user-id').value=userId;
  document.getElementById('umod-amount').value='';
  document.getElementById('umod-overlay').style.display='flex';
  document.getElementById('umod-amount').focus();
}

function umodClose(){ document.getElementById('umod-overlay').style.display='none'; document.getElementById('umod-status').textContent=''; }

async function umodSave(){
  var userId=document.getElementById('umod-user-id').value,isPlan=document.getElementById('umod-plan-section').style.display!=='none',statusEl=document.getElementById('umod-status');
  statusEl.style.color='var(--muted)'; statusEl.textContent='Saving…';
  if(isPlan){
    var plan=document.getElementById('umod-plan').value.trim().toLowerCase();
    if(!['free','creator','pro','developer'].includes(plan)){ statusEl.style.color='#ef4444'; statusEl.textContent='Invalid plan name.'; return; }
    var res=await fetch('/api/admin/user/update',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({user_id:userId,plan:plan})});
    var data=await res.json(); if(data.ok){ statusEl.style.color='#10b981'; statusEl.textContent='Plan updated'; window._usersLoaded=false; loadUsers(); setTimeout(umodClose,1000); } else { statusEl.style.color='#ef4444'; statusEl.textContent='Error: '+(data.error||'Failed'); }
  } else {
    var amt=parseInt(document.getElementById('umod-amount').value);
    if(!amt||isNaN(amt)||amt<=0){ statusEl.style.color='#ef4444'; statusEl.textContent='Enter a positive number.'; return; }
    var res2=await fetch('/api/admin/user/add-credits',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({user_id:userId,amount:amt})});
    var data2=await res2.json(); if(data2.ok){ statusEl.style.color='#10b981'; statusEl.textContent='Added '+amt+' pts, new limit: '+data2.gens_limit; window._usersLoaded=false; loadUsers(); setTimeout(umodClose,1800); } else { statusEl.style.color='#ef4444'; statusEl.textContent='Error: '+(data2.error||'Failed'); }
  }
}
