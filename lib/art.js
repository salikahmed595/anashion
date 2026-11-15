'use strict';
// Drawings used wherever a photo has not been uploaded yet: a fabric swatch
// (CSS class sw-<name>) with a stitched outline of the garment on top.

const SWATCHES = {
  jacquard: 'Jacquard', linen: 'Linen', velvet: 'Velvet', leather: 'Leather', denim: 'Denim',
  tweed: 'Tweed', suede: 'Suede', corduroy: 'Corduroy', knit: 'Knit', wool: 'Wool check',
};

const SKETCHES = {
  dress: '<path class="cut" d="M78 28Q100 50 122 28L134 32 130 80 168 178H32L70 80 66 32Z"/><path class="seam" d="M70 80H130M40 166H160"/>',
  tee: '<path class="cut" d="M72 38Q100 58 128 38L174 62 158 94 138 84V170H62V84L42 94 26 62Z"/><path class="seam" d="M62 160H138M34 76 50 84M166 76 150 84"/>',
  candle: '<path class="cut" d="M100 30C112 48 110 62 100 66 90 62 88 48 100 30Z"/><path class="cut" d="M60 84H140Q146 84 146 90V168Q146 176 138 176H62Q54 176 54 168V90Q54 84 60 84Z"/><path class="seam" d="M100 66V84M76 112H124V146H76Z"/>',
  bag: '<path class="seam" d="M68 86C68 16 132 16 132 86"/><path class="cut" d="M40 86H160Q168 86 170 96L178 160Q180 174 168 174H32Q20 174 22 160L30 96Q32 86 40 86Z"/><path class="seam" d="M28 110Q100 142 172 110M91 122H109V136H91Z"/>',
  trousers: '<path class="cut" d="M62 26H138L150 178H112L100 78 88 178H50Z"/><path class="seam" d="M61 40H139M100 40V74M74 40Q72 58 58 64M126 40Q128 58 142 64"/>',
  blazer: '<path class="cut" d="M80 30H120L156 44 176 156 154 160 146 96 148 176H52L54 96 46 160 24 156 44 44Z"/><path class="seam" d="M80 30 66 62 100 102 134 62 120 30M100 102V176M62 134H88M112 134H138"/><circle class="seam" cx="107" cy="120" r="2.5"/><circle class="seam" cx="107" cy="146" r="2.5"/>',
  shoe: '<path class="cut" d="M26 112C26 101 37 98 47 102 61 108 71 119 91 124 117 130 154 129 172 137 184 143 186 152 180 156H26Z"/><path class="cut" d="M24 156H182L178 164H62V172H26Z"/><path class="seam" d="M91 124C97 112 115 112 122 127M32 148H178"/>',
  shirt: '<path class="cut" d="M78 30 100 44 122 30 160 46 178 150 156 154 146 92V174H54V92L44 154 22 150 40 46Z"/><path class="seam" d="M78 30 88 58 100 44 112 58 122 30M100 44V174M112 86H132V108H112Z"/><circle class="seam" cx="100" cy="74" r="2"/><circle class="seam" cx="100" cy="102" r="2"/><circle class="seam" cx="100" cy="130" r="2"/><circle class="seam" cx="100" cy="158" r="2"/>',
  sweater: '<path class="cut" d="M76 38Q100 54 124 38L158 52 184 140 162 148 144 96V168H56V96L38 148 16 140 42 52Z"/><path class="seam" d="M76 38Q100 66 124 38M56 156H144M19.5 128.5 41.5 136.5M180.5 128.5 158.5 136.5"/>',
  sunglasses: '<g transform="translate(0 46)"><path class="cut" d="M26 78H86Q91 78 90 86C87 118 73 128 55 128 37 128 24 116 22 86Q21 78 26 78Z"/><path class="cut" d="M114 78H174Q179 78 178 86C176 116 163 128 145 128 127 128 113 118 110 86Q109 78 114 78Z"/><path class="seam" d="M90 86Q100 76 110 86M22 84 8 76M178 84 192 76"/></g>',
  hanger: '<g transform="translate(0 30)"><path class="seam" d="M100 80V68C100 58 116 56 116 43 116 30 98 26 89 38"/><path class="cut" d="M100 80 178 128Q186 136 174 138H26Q14 136 22 128Z"/></g>',
};

function sketchSvg(name) {
  const body = SKETCHES[name] || SKETCHES.hanger;
  return `<svg class="flat" viewBox="0 0 200 200" aria-hidden="true">${body}</svg>`;
}

const ICON = {
  chevDown: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4 6 8.5 10.5 4"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 7h18M3 12h18M3 17h18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></svg>',
  parcel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.5" width="17" height="13" rx="2.5"/><path d="M8.5 7.5V6a3.5 3.5 0 0 1 7 0v1.5"/></svg>',
  plus: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M9 2v14M2 9h14"/></svg>',
  up: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12.5 10 6l6.5 6.5"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r=".6" fill="currentColor"/></svg>',
  facebook: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M13.3 20.5v-6.2h2.1l.4-2.6h-2.5v-1.6c0-.8.3-1.4 1.5-1.4h1.2V6.4c-.5-.1-1.2-.2-1.9-.2-2 0-3.300 1.2-3.300 3.400v2.100H8.600v2.600h2.200v6.200z" fill="#FAF9F5"/></svg>',
  needle: '<svg viewBox="0 0 40 84" fill="none"><path d="M20 3c2.200 7 2.400 20 1.200 60L20 81l-1.200-18C17.600 23 17.800 10 20 3Z" fill="#1B1A18"/><ellipse cx="20" cy="13" rx=".9" ry="3.6" fill="#FAF9F5"/><path d="M20 13c14 4 14 17 2 21-13 5-13 18 2 22 9 2.400 10 10 4 16" stroke="#1B1A18" stroke-width="1.2" stroke-linecap="round"/></svg>',
};

module.exports = { SWATCHES, SKETCHES, sketchSvg, ICON };
