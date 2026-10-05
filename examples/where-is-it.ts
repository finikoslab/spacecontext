// Ask every space you own where something is, and print the best answer with its evidence.
//
//   SPACECONTEXT_API_KEY=sc_test_… node --experimental-strip-types examples/where-is-it.ts "spare light bulbs"
import { SpaceContext } from '@spacecontext/sdk';

const question = process.argv.slice(2).join(' ') || 'where is the stopcock?';
const sc = new SpaceContext();

const { data } = await sc.search(question, { limit: 5 });
if (data.length === 0) {
  console.log('Not documented in any of your spaces.');
} else {
  const best = data[0]!;
  const answer = await sc.spaces.ask(best.space_id, question);
  console.log(`${best.space_name}: ${answer.answer}`);
  for (const citation of answer.citations) {
    const photo = citation.evidence.find((entry) => entry.url)?.url;
    console.log(`  - ${citation.title}${citation.area ? ` (${citation.area})` : ''}${photo ? `\n    ${photo}` : ''}`);
  }
}
