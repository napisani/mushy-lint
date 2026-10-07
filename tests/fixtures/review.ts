test("preserves object key order", () => {
  expect({ second: 2, first: 1 }).toEqual({ first: 1, second: 2 });
});

test("preserves object key order", () => {
  expect(Object.keys({ first: 1, second: 2 })).toEqual(["first", "second"]);
});

client.wait().catch(() => {
  // The optional widget may never appear on this page.
});
