import {expect, test} from "@jest/globals"

test("Hello, World", async () => {
  const input = "Hello, World!"
  await expect(Promise.resolve(input)).resolves.toBe("Hello, World!")
})
