import { parseLsdata } from '../../src/discovery/adapters/webdynpro/lsdata.js';

/**
 * Development regression check for `lsdata.ts` — not part of `src/`, so it
 * never ships in `dist/`, and not wired to any CI step; run by hand with
 * `npm run check:lsdata` after touching the parser. Pure function, no
 * browser needed.
 */

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `   ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
  );
  if (ok) pass++;
  else fail++;
}

console.log('1) Well-formed positional array, every slot present');
check(
  "['InputField','WD01','Company Code','ACME','X','X','','X','','']",
  parseLsdata("['InputField','WD01','Company Code','ACME','X','X','','X','','']"),
  {
    controlType: 'InputField',
    properties: {
      id: 'WD01',
      label: 'Company Code',
      value: 'ACME',
      enabled: true,
      visible: true,
      readOnly: false,
      required: true,
      dataType: '',
      valueHelp: false,
    },
  },
);

console.log('\n2) Missing trailing slots default sensibly');
check(
  "['DropDownByKey','WD02']",
  parseLsdata("['DropDownByKey','WD02']"),
  {
    controlType: 'DropDownByKey',
    properties: {
      id: 'WD02',
      label: '',
      value: '',
      enabled: true,
      visible: true,
      readOnly: false,
      required: false,
      dataType: '',
      valueHelp: false,
    },
  },
);

console.log('\n3) Disabled + read-only flags');
check(
  "['InputField','WD10','Locked Field','fixed','','X','X','','','']",
  parseLsdata("['InputField','WD10','Locked Field','fixed','','X','X','','','']")
    ?.properties,
  {
    id: 'WD10',
    label: 'Locked Field',
    value: 'fixed',
    enabled: false,
    visible: true,
    readOnly: true,
    required: false,
    dataType: '',
    valueHelp: false,
  },
);

console.log('\n4) Value-help and date-typed InputFields');
check(
  'valueHelp flag',
  parseLsdata("['InputField','WD03','','','X','X','','','','X']")?.properties.valueHelp,
  true,
);
check(
  'dataType DATE',
  parseLsdata("['InputField','WD04','Start Date','','X','X','','','DATE','']")?.properties
    .dataType,
  'DATE',
);

console.log('\n5) Empty slots via doubled commas');
check(
  "['CheckBox','WD05',,,'X','X']",
  parseLsdata("['CheckBox','WD05',,,'X','X']"),
  {
    controlType: 'CheckBox',
    properties: {
      id: 'WD05',
      label: '',
      value: '',
      enabled: true,
      visible: true,
      readOnly: false,
      required: false,
      dataType: '',
      valueHelp: false,
    },
  },
);

console.log('\n6) Escaped single quote inside a value');
check(
  "escaped quote in label",
  parseLsdata("['InputField','WD06','Tenant\\'s Name','','X','X']")?.properties.label,
  "Tenant's Name",
);

console.log('\n7) Malformed input returns null, never throws');
check('null input', parseLsdata(null), null);
check('undefined input', parseLsdata(undefined), null);
check('empty string', parseLsdata(''), null);
check('whitespace only', parseLsdata('   '), null);
check('not wrapped in brackets', parseLsdata("'InputField','WD01'"), null);
check('missing closing bracket', parseLsdata("['InputField','WD01'"), null);
check('missing opening bracket', parseLsdata("'InputField','WD01']"), null);
check('unterminated string', parseLsdata("['InputField,'WD01']"), null);
check('bare unquoted token', parseLsdata('[InputField,WD01]'), null);
check('empty array (no control type)', parseLsdata('[]'), null);
check('leading empty control type', parseLsdata("['','WD01']"), null);
check('trailing garbage after bracket', parseLsdata("['InputField','WD01'] garbage"), null);
check('random non-array text', parseLsdata('hello world'), null);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
