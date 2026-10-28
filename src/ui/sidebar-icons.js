'use strict';
// Eight identical teeth share one center; app.js consumes this before hydrating icons.
(() => {
  const point = (radius, degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return [12 + radius * Math.cos(radians), 12 + radius * Math.sin(radians)]
      .map((value) => Number(value.toFixed(4)))
      .join(' ');
  };
  const points = [];
  for (let tooth = 0; tooth < 8; tooth++)
    for (const [angle, radius] of [
      [-22.5, 7.3],
      [-12, 7.3],
      [-9, 9.2],
      [9, 9.2],
      [12, 7.3]
    ])
      points.push(point(radius, tooth * 45 + angle));
  window.albumSidebarIcons = Object.freeze({
    settings: `<path d="M${points.join('L')}Z"/><circle cx="12" cy="12" r="3"/>`,
    pin: '<path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z"/><path d="M12 15v6"/>'
  });
})();
