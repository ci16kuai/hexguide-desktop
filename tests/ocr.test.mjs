import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchOcrProposals} from '../server/ocr.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const augments = data.augments;
const eligible = augments.filter(item => item.availability === 'current' && item.recommendable !== false && !item.retiredPatch && !item.isInternalTemplate);
const byName = new Map(eligible.map(item => [item.name, item]));
const normal = text => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const title = (text, column, extra = {}) => ({text,x:[525,1135,1765][column],y:478,width:Math.max(50,text.length * 28),height:31,pass:'full-window',...extra});
const frame = lines => ({status:'recognized',diagnostics:{width:2560,height:1440},lines});
const run = (names, extras = []) => matchOcrProposals(frame([...names.map((name,index) => title(name,index)),...extras]),augments);

test('three exact titles in the real Windows OCR geometry become a confirmation draft in screen order', () => {
  const result = run(['钢化你心','歌利亚巨人','渴血']);
  assert.equal(result.status,'recognized');
  assert.deepEqual(result.proposals.map(item => item.name),['钢化你心','歌利亚巨人','渴血']);
  assert.ok(result.proposals.every(item => item.confidence === 'exact'));
  assert.match(result.message,/核对/);
  assert.ok(!('owned' in result));
  assert.ok(!JSON.stringify(result).includes('diagnostics'));
});

test('a battle player name containing Goliath and descriptions cannot become card offers', () => {
  const result = matchOcrProposals(frame([
    title('Goliath Astie',0),
    title('任务：钢化你心的效果触发了',1),
    title('获得邦！并增加伤害',2),
  ]),augments);
  assert.equal(result.status,'unavailable');
  assert.deepEqual(result.proposals,[]);
  assert.equal(run(['歌利亚巨人','钢化你心']).status,'unavailable','two HUD dictionary hits never claim that this is a choice screen');
});

test('short names are allowed only as complete titles, never as substrings', () => {
  for (const name of ['大力','渴血','易损','灵巧','虹吸','邦！','复位','装填']) {
    assert.ok(byName.has(name),`${name} exists in the real current catalog`);
    assert.equal(run([name,'钢化你心','歌利亚巨人']).proposals[0]?.name,name);
    assert.equal(run([`获得${name}的效果`,'钢化你心','歌利亚巨人']).status,'unavailable');
  }
});

test('longer exact names win over embedded catalog names without substring matching', () => {
  for (const name of ['无限循环往复','终极循环往复','灵魂虹吸','属性叠属性叠属性！']) {
    const result = run([name,'钢化你心','歌利亚巨人']);
    assert.equal(result.proposals[0]?.name,name);
    assert.equal(result.proposals.length,3);
  }
  assert.equal(run(['无限循环往复','循环往复','歌利亚巨人']).proposals.length,3);
});

test('the current 244 selectable definitions are eligible, including every unique short name', () => {
  assert.equal(eligible.length,244);
  let checked = 0;
  for (const augment of eligible) {
    // Names differing only in punctuation need that punctuation in the OCR.
    const collisions = eligible.filter(item => normal(item.name) === normal(augment.name));
    if (collisions.length > 1 && !/[\p{P}\p{S}]/u.test(augment.name)) continue;
    const anchors = ['钢化你心','歌利亚巨人','渴血'].filter(name => name !== augment.name).slice(0,2);
    const result = run([augment.name,...anchors]);
    assert.equal(result.proposals[0]?.id,augment.id,augment.name);
    checked++;
  }
  assert.ok(checked >= 240);
});

test('OCR can split three titles from one line only with exact full coverage and word boxes', () => {
  const names = ['大力','无限循环往复','歌利亚巨人'];
  const words = names.map((text,column) => title(text,column));
  const raw = frame([{text:names.join(' '),x:525,y:478,width:1400,height:31,words}]);
  const result = matchOcrProposals(raw,augments);
  assert.deepEqual(result.proposals.map(item => item.name),names);
  assert.equal(matchOcrProposals(frame([{...raw.lines[0],text:`获得 ${raw.lines[0].text}`,words:[{text:'获得',x:300,y:478,width:60,height:31},...words]}]),augments).status,'unavailable');
  assert.equal(matchOcrProposals(frame([{...raw.lines[0],words:undefined}]),augments).status,'unavailable','a merged line without geometry cannot prove three card columns');
});

test('separate frames, passes, vertical rows and duplicate names cannot be combined into an offer', () => {
  const names = ['大力','无限循环往复','歌利亚巨人'];
  for (const lines of [
    names.map((name,index) => title(name,index,{frameId:String(index)})),
    names.map((name,index) => title(name,index,{pass:String(index)})),
    names.map((name,index) => title(name,index,{y:300+index*150})),
    names.map((name,index) => title(name,index,{x:525})),
    names.map((name,index) => title(name,index,{y:1200})),
    ['大力','大力','歌利亚巨人'].map((name,index) => title(name,index)),
  ]) assert.equal(matchOcrProposals(frame(lines),augments).status,'unavailable');
  const conflicting = frame([
    ...names.map((name,index) => title(name,index,{frameId:'before'})),
    ...['渴血','易损','钢化你心'].map((name,index) => title(name,index,{frameId:'after'})),
  ]);
  assert.equal(matchOcrProposals(conflicting,augments).status,'unavailable');
});

test('missing geometry, misspellings, ambiguous punctuation and stale catalog names are not guessed', () => {
  assert.equal(matchOcrProposals({status:'recognized',lines:['大力','渴血','钢化你心'].map(text=>({text}))},augments).status,'unavailable');
  assert.equal(run(['钢化你芯','歌利亚巨人','渴血']).status,'unavailable');
  assert.equal(run(['罪恶快感','歌利亚巨人','渴血']).status,'unavailable');
  assert.equal(run(['罪恶快感！','歌利亚巨人','渴血']).proposals[0]?.name,'罪恶快感！');
  const retired = augments.find(item => item.availability !== 'current');
  assert.equal(run([retired.name,'歌利亚巨人','渴血']).status,'unavailable');
});

