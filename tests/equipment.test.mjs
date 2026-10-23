import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {shortItemEffect,equipmentCards} from '../dist/statistics-view.js';

test('equipment summaries use catalog effects and omit unresolved dynamic numbers',()=>{
  assert.equal(shortItemEffect('105法术强度\n50护甲\n\n时间停止\n进入凝滞状态2.5秒。'),'进入凝滞状态2.5秒。');
  assert.equal(shortItemEffect('30%攻击速度\n45移动速度'),'30%攻击速度、45移动速度');
  const text=shortItemEffect('1000生命值\n\n每秒回复0生命值。\n获得额外生命值，相当于你12%的装备生命值(0)。');
  assert.match(text,/每秒回复生命值/);
  assert.match(text,/12%/);
  assert.doesNotMatch(text,/回复0|\(0\)/);
  assert.equal(shortItemEffect('造成{{ unparsed }}魔法伤害。\n黑暗契约：提供相当于你2%额外生命值的法术强度。'),'黑暗契约：提供相当于你2%额外生命值的法术强度。');
});

test('equipment cards only resolve exact catalog IDs, deduplicate and cap six entries',()=>{
  const data=Object.fromEntries(Array.from({length:8},(_,n)=>[String(n),{id:String(n),name:`装备${n}`,icon:`https://example.test/${n}.png`,description:'造成额外魔法伤害。'}]));
  const result=equipmentCards({choices:[{items:[{id:'missing',name:'猜测名称',reason:'不要使用此建议作为效果'},{id:'0',reason:'不要使用此建议作为效果'},{id:'0'}]},{items:Array.from({length:8},(_,n)=>({id:String(n)}))}]},{data});
  assert.equal(result.length,6);
  assert.equal(new Set(result.map(item=>item.id)).size,6);
  assert.ok(result.every(item=>item.effect==='造成额外魔法伤害。'));
  assert.equal(equipmentCards({choices:[{items:[{id:'bad'}]}]},{data:{bad:{id:'different',name:'装备',icon:'https://example.test/item.png',description:'造成伤害。'}}}).length,0);
});

test('real catalog summaries remain short and retain item icons and names',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../dist/items.json',import.meta.url),'utf8'));
  const ids=['3089','3116','3157','3102','3068','3065','6617','3504','3031','3153','3115','3078','3161'];
  const cards=equipmentCards({choices:ids.map(id=>({items:[{id}]}))},catalog);
  assert.equal(cards.length,6);
  for(const item of cards){
    assert.equal(item.name,catalog.data[item.id].name);
    assert.equal(item.icon,catalog.data[item.id].icon);
    assert.ok(item.effect.length>0&&Array.from(item.effect).length<=100);
    assert.doesNotMatch(item.effect,/{{|}}|\(0\)|(?<![\d.])0(?:伤害|生命值|法力值)/);
  }
});
