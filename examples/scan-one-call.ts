// From a video to the space's document in one call, with live progress.
//
//   SPACECONTEXT_API_KEY=sc_live_… node --experimental-strip-types examples/scan-one-call.ts ./flat.mp4 "Seaside flat"
//
// With an sc_test_ key nothing is charged and the result is the demo space.
import { SpaceContext, SpaceContextError } from '@spacecontext/sdk';

const [file = './flat.mp4', name = 'Seaside flat'] = process.argv.slice(2);
const sc = new SpaceContext(); // reads SPACECONTEXT_API_KEY

try {
  const { spaceId, document, markdown } = await sc.scan(file, {
    name,
    type: 'apartment',
    format: 'markdown',
    onProgress: (p) => {
      if (p.type === 'scan') console.log(p.stage === 'complete' ? '  Done.' : `  ${p.label}…`);
      else if (p.type === 'uploading') console.log(`  Uploading ${p.part}/${p.parts}…`);
      else console.log(`  ${p.type}`);
    },
  });

  console.log(`\n${document.space.name} (${spaceId}): ${document.stats.areas} areas, ${document.stats.items} items, ${document.stats.issues} issues\n`);
  console.log(markdown);

  const answer = await sc.spaces.ask(spaceId, 'Where is the fuse box?');
  console.log(answer.documented ? answer.answer : 'Not documented.');
} catch (error) {
  if (error instanceof SpaceContextError) {
    // The scan's own error (FOOTAGE_UNUSABLE, ANALYSIS_EMPTY…) or the API's (INSUFFICIENT_FUNDS…): nothing is charged for a failed scan.
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
