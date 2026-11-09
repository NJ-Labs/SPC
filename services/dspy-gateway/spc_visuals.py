"""Deterministic interactive explanations for models that cannot author working HTML."""

import json
import math
from typing import Any


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


STYLE = """<style>
.spc-visual{font:14px var(--spc-font,system-ui);color:var(--spc-fg,#172b3a);line-height:1.5}
h3{margin:0 0 8px}p{margin:6px 0}.muted{color:var(--spc-muted,#526678);font-size:12px}
label{display:block;font-weight:600;margin:12px 0 5px}input,select{width:100%;max-width:100%;box-sizing:border-box}
.metrics{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.metrics div{padding:8px 12px;border:1px solid var(--spc-border,#cbd5e1);border-radius:8px}
.metrics strong{display:block;font-size:20px;font-variant-numeric:tabular-nums}svg{display:block;width:100%;height:150px}
button{font:inherit;padding:5px 12px;border:1px solid var(--spc-border,#cbd5e1);border-radius:6px;cursor:pointer}
</style>"""

CAPABILITY = r"""<section class="spc-visual" dir="$DIR">
<h3 id="heading"></h3><p class="muted" id="note"></p>
<svg viewBox="0 0 320 150" role="img" aria-labelledby="heading"><path id="curve" fill="none" stroke="var(--spc-accent,#0f766e)" stroke-width="3"></path><g id="specs"></g></svg>
<label for="process-mean" id="mean-label"></label><input id="process-mean" type="range"><output id="mean-value" for="process-mean"></output>
<div class="metrics" aria-live="polite"><div>Cp<strong id="cp"></strong></div><div>Cpk<strong id="cpk"></strong></div><div id="sigma-label"></div></div>
<button type="button" id="reset"></button><p class="muted" id="readiness"></p>
<script>(function(){'use strict';var d=$DATA;
var mean=document.getElementById('process-mean'),fmt=function(v){return Number.isFinite(v)?v.toFixed(3):'—';};
document.getElementById('heading').textContent=d.he?'הדמיית יכולת תהליך':'Capability what-if';
document.getElementById('note').textContent=d.he?'הדמיה בלבד: שינוי הממוצע כאן אינו משנה את הגדרות התרשים. סיגמה והמפרטים נשארים קבועים.':'Simulation only: moving the mean here does not change chart settings. Sigma and specifications stay fixed.';
document.getElementById('mean-label').textContent=d.he?'ממוצע מדומה':'Simulated mean';
document.getElementById('reset').textContent=d.he?'איפוס לנתונים':'Reset to data';
document.getElementById('readiness').textContent=d.readiness;
document.getElementById('sigma-label').textContent=(d.he?'סיגמה תוך-תהליכית: ':'Within sigma: ')+fmt(d.sigma);
var lo=Math.min(d.mean-6*d.sigma,d.lsl===null?Infinity:d.lsl-3*d.sigma),hi=Math.max(d.mean+6*d.sigma,d.usl===null?-Infinity:d.usl+3*d.sigma),span=hi-lo;
mean.min=lo;mean.max=hi;mean.step=span/1000;mean.value=d.mean;
var x=function(v){return 10+300*(v-lo)/span;},ns='http://www.w3.org/2000/svg';
[['LSL',d.lsl],['USL',d.usl]].forEach(function(spec){if(spec[1]===null)return;var line=document.createElementNS(ns,'line');line.setAttribute('x1',x(spec[1]));line.setAttribute('x2',x(spec[1]));line.setAttribute('y1',5);line.setAttribute('y2',130);line.setAttribute('stroke','var(--spc-danger,#b91c1c)');line.setAttribute('stroke-dasharray','4 3');document.getElementById('specs').appendChild(line);var label=document.createElementNS(ns,'text');label.setAttribute('x',Math.max(4,Math.min(245,x(spec[1])+3)));label.setAttribute('y',146);label.setAttribute('fill','currentColor');label.setAttribute('font-size','14');label.textContent=spec[0]+' '+fmt(spec[1]);document.getElementById('specs').appendChild(label);});
function draw(value){var cpu=d.usl===null?Infinity:(d.usl-value)/(3*d.sigma),cpl=d.lsl===null?Infinity:(value-d.lsl)/(3*d.sigma);document.getElementById('cp').textContent=d.lsl===null||d.usl===null?'—':fmt((d.usl-d.lsl)/(6*d.sigma));document.getElementById('cpk').textContent=fmt(Math.min(cpu,cpl));document.getElementById('mean-value').textContent=fmt(value);var points=[];for(var i=0;i<=180;i++){var v=lo+span*i/180,z=(v-value)/d.sigma;points.push((i?'L':'M')+x(v).toFixed(2)+' '+(128-112*Math.exp(-0.5*z*z)).toFixed(2));}document.getElementById('curve').setAttribute('d',points.join(' '));}
mean.addEventListener('input',function(){draw(Number(mean.value));});document.getElementById('reset').addEventListener('click',function(){mean.value=d.mean;draw(d.mean);});draw(d.mean);
})();</script></section>"""

RULES = r"""<section class="spc-visual" dir="$DIR"><h3 id="heading"></h3><p class="muted" id="note"></p>
<label for="spc-rule" id="rule-label"></label><select id="spc-rule"></select>
<p id="description"></p><div class="metrics" aria-live="polite"><div id="count-label"></div></div>
<svg viewBox="0 0 320 150" role="img" aria-labelledby="zone-title"><title id="zone-title">Standardized sigma zones</title><rect x="10" y="10" width="300" height="120" fill="var(--spc-accent-soft,#f0fdfa)"/><g id="zones"></g></svg>
<p class="muted" id="interpretation"></p>
<script>(function(){'use strict';var d=$DATA,select=document.getElementById('spc-rule');
document.getElementById('heading').textContent=d.limitOnly?'EWMA · control-limit test':d.set==='westernElectric'?'Western Electric · 4 rules':'Nelson · 8 tests';
document.getElementById('note').textContent=d.he?'חלונות חופפים יכולים לשתף נקודות. ההסבר אינו משנה הגדרות.':'Overlapping windows can share points. This explanation does not change settings.';
document.getElementById('rule-label').textContent=d.he?'בחירת כלל':'Choose a rule';
document.getElementById('interpretation').textContent=d.he?'אות הוא סיבה לבדיקה של התהליך; הוא אינו קביעה על התאמה למפרט.':'A signal prompts process investigation; it is not a verdict about product specifications.';
d.rules.forEach(function(rule){var option=document.createElement('option');option.value=rule.id;option.textContent=(d.he?'כלל ':'Rule ')+rule.id;select.appendChild(option);});
var ns='http://www.w3.org/2000/svg';for(var z=-3;z<=3;z++){var line=document.createElementNS(ns,'line'),y=70-z*20;line.setAttribute('x1',50);line.setAttribute('x2',310);line.setAttribute('y1',y);line.setAttribute('y2',y);line.setAttribute('stroke',z===0?'var(--spc-accent,#0f766e)':'var(--spc-border,#94a3b8)');line.setAttribute('stroke-dasharray',z===0?'0':'4 3');document.getElementById('zones').appendChild(line);var label=document.createElementNS(ns,'text');label.setAttribute('x',10);label.setAttribute('y',y+4);label.setAttribute('fill','currentColor');label.setAttribute('font-size','14');label.textContent=(z>0?'+':'')+z+'σ';document.getElementById('zones').appendChild(label);}
function show(){var r=d.rules.find(function(rule){return rule.id===Number(select.value);});if(!r)return;document.getElementById('description').textContent=r.description;document.getElementById('count-label').textContent=r.count===null?(d.he?'מספר אותות אינו זמין':'Signal count unavailable'):(d.he?'אותות שנמצאו: ':'Detected signals: ')+r.count;}
select.addEventListener('change',show);show();})();</script></section>"""

NELSON = [
    'One point beyond a control limit.',
    '9 consecutive points on the same side of the center line.',
    '6 consecutive points strictly increasing or decreasing.',
    '14 consecutive points alternating up and down.',
    '2 of 3 consecutive points beyond 2 sigma on the same side.',
    '4 of 5 consecutive points beyond 1 sigma on the same side.',
    '15 consecutive points strictly within 1 sigma.',
    '8 consecutive points beyond 1 sigma, with points on both sides.',
]
WESTERN = [NELSON[0], NELSON[4], NELSON[5], '8 consecutive points on the same side of the center line.']


def build_spc_visual(processed: dict[str, Any] | None, controls: dict[str, Any], topic: str, language: str = 'en') -> str | None:
    processed = processed if isinstance(processed, dict) else {}
    he = language == 'he'
    if topic == 'capability':
        if controls.get('chartType') not in {'individual', 'xBarR', 'xBarS', 'ewma'}:
            return None
        capability = _mapping(processed.get('capabilityStatus'))
        estimates = _mapping(capability.get('sigmaEstimate'))
        limits = _mapping(processed.get('controlLimits'))
        mean = _number(_mapping(processed.get('statistics')).get('mean'))
        sigma = _number(estimates.get('within', limits.get('processSigma')))
        lower, upper = _number(controls.get('lowerSpecLimit')), _number(controls.get('upperSpecLimit'))
        if mean is None or sigma is None or sigma <= 0 or (lower is None and upper is None):
            return None
        if lower is not None and upper is not None and upper <= lower:
            return None
        slider_min = min(mean - 6 * sigma, lower - 3 * sigma if lower is not None else mean)
        slider_max = max(mean + 6 * sigma, upper + 3 * sigma if upper is not None else mean)
        if not math.isfinite(slider_max - slider_min) or slider_max <= slider_min:
            return None
        data = {'mean': mean, 'sigma': sigma, 'lsl': lower, 'usl': upper, 'he': he,
                'readiness': str(capability.get('readiness', 'preliminary')) + ': ' + ' '.join(str(reason) for reason in capability.get('reasons', [])[:3])}
        template = CAPABILITY
    elif topic == 'rules':
        if controls.get('chartType') in {'histogram', 'scatterPlot'}:
            return None
        summary = _mapping(processed.get('ruleSummary'))
        rule_set = summary.get('ruleSet', controls.get('ruleSet', 'nelson'))
        descriptions = WESTERN if rule_set == 'westernElectric' else NELSON
        limit_only = controls.get('chartType') == 'ewma'
        if limit_only:
            descriptions = descriptions[:1]
        rows = summary.get('rules') if isinstance(summary.get('rules'), list) else []
        counts = {row.get('ruleNumber'): _number(row.get('signalCount')) for row in rows if isinstance(row, dict)}
        rules = [{'id': i + 1, 'description': text, 'count': counts.get(i + 1, 0 if summary else None)} for i, text in enumerate(descriptions)]
        data = {'set': rule_set, 'rules': rules, 'he': he, 'limitOnly': limit_only}
        template = RULES
    else:
        return None
    payload = json.dumps(data, ensure_ascii=True, allow_nan=False).replace('<', r'\u003c')
    return STYLE + template.replace('$DIR', 'rtl' if he else 'ltr').replace('$DATA', payload)
