const { bn, MAX_UINT256, MAX_UINT192 } = require('@aragon/contract-helpers-test')
const { assertRevert, assertBn } = require('@aragon/contract-helpers-test/src/asserts')

const { TREE_ERRORS, CHECKPOINT_ERRORS, MATH_ERRORS } = require('../helpers/utils/errors')

const HexSumTree = artifacts.require('HexSumTreeMock')

contract('HexSumTree', () => {
  let tree

  beforeEach('create tree', async () => {
    tree = await HexSumTree.new()
  })

  describe('init', () => {
    it('initializes the tree with one level', async () => {
      await tree.init()

      assertBn((await tree.height()), 1, 'tree height does not match')
      assertBn((await tree.nextKey()), 0, 'next key does not match')
    })

    it('total value stored in the root is zero', async () => {
      assertBn((await tree.total()), 0, 'last total stored in the root does not match')

      const rootKey = 0
      const rootLevel = await tree.height()
      assertBn((await tree.node(rootLevel, rootKey)), 0, 'last value stored in the root does not match')
    })

    it('does not have items inserted yet', async () => {
      assertBn((await tree.item(0)), 0, 'item with key #0 does not match')
      assertBn((await tree.item(1)), 0, 'item with key #1 does not match')
    })
  })

  describe('insert', () => {
    beforeEach('init tree', async () => {
      await tree.init()
    })

    context('when the total does not overflow', () => {
      context('when adding one value', () => {
        const time = 2
        const value = 5

        it('inserts the given value at level 0', async () => {
          const key = await tree.nextKey()
          await tree.insert(time, value)

          assertBn((await tree.item(key)), value, 'value does not match')
          assertBn((await tree.itemAt(key, 0)), 0, 'past value does not match')
          assertBn((await tree.itemAt(key, time)), value, 'last value does not match')
        })

        it('does not affect other keys', async () => {
          const key = await tree.nextKey()
          await tree.insert(time, value)

          assertBn((await tree.item(key.add(bn(1)))), 0, 'item with key #1 does not match')
        })

        it('updates the next key but not the height of the tree', async () => {
          await tree.insert(time, value)

          assertBn((await tree.height()), 1, 'tree height does not match')
          assertBn((await tree.nextKey()), 1, 'next key does not match')
        })

        it('updates the total value stored in the root', async () => {
          await tree.insert(time, value)

          assertBn((await tree.total()), value, 'last total stored in the root does not match')

          const rootKey = 0
          const rootLevel = await tree.height()
          assertBn((await tree.node(rootLevel, rootKey)), value, 'last value stored in the root does not match')
          assertBn((await tree.nodeAt(rootLevel, rootKey, 0)), 0, 'past value stored in the root does not match')
          assertBn((await tree.nodeAt(rootLevel, rootKey, time)), value, 'last value stored in the root does not match')
        })

        it('does not allow adding another value before the insertion time', async () => {
          await tree.insert(time, value)

          await assertRevert(tree.insert(time - 1, 10), CHECKPOINT_ERRORS.CANNOT_ADD_PAST_VALUE)
        })

        it('allows adding another value at the same time', async () => {
          await tree.insert(time, value)

          await tree.insert(time, 10)
          assertBn((await tree.item(1)), 10, 'value does not match')
        })
      })

      context('when adding 40 values', () => {
        beforeEach('insert 40 values', async () => {
          // First 16 set of children will be         1^0, 1^1, 1^2, ..., 1^15 at time i+1
          // Second 16 set of children will be        2^0, 2^1, 2^2, ..., 2^15 at time i+1
          // Final 8 set of remaining values will be  3^0, 3^1, 3^2, ..., 3^7  at time i+1

          for (let key = 0; key < 40; key++) {
            const time = key + 1
            await tree.insert(time, value(key))
          }
        })

        const value = key => {
          const base = Math.floor(key / 16) + 1
          const exponent = key % 16
          return Math.pow(base, exponent)
        }

        it('updates the next key and the height of the tree', async () => {
          assertBn((await tree.height()), 2, 'tree height does not match')
          assertBn((await tree.nextKey()), 40, 'next key does not match')
        })

        it('inserts the given values at level 0', async () => {
          for (let key = 0; key < 40; key++) {
            const time = key + 1
            const expectedValue = value(key)

            assertBn((await tree.item(key)), expectedValue, 'value does not match')
            assertBn((await tree.itemAt(key, time - 1)), 0, 'past value does not match')
            assertBn((await tree.itemAt(key, time)), expectedValue, 'last value does not match')
          }
        })

        it('does not affect the next key', async () => {
          const nextKey = await tree.nextKey()

          assertBn((await tree.item(nextKey)), 0, 'value of the next key does not match')
        })

        it('updates the total value stored in the root', async () => {
          const rootKey = 0
          let expectedTotal = 0

          for (let key = 0; key < 40; key++) {
            const time = key + 1
            expectedTotal += value(key)

            const rootLevel = await tree.heightAt(time)
            assertBn((await tree.nodeAt(rootLevel, rootKey, time)), expectedTotal, 'total value stored in the root does not match')
          }

          assertBn((await tree.total()), expectedTotal, 'last total stored in the root does not match')
        })

        it('updates the total values stored in the middle nodes', async () => {
          let expectedMiddleTotal = 0
          for (let key = 0; key < 40; key++) {
            const time = key + 1

            // For 40 samples, the height of the tree will be 1 for the first 16 items and 2 for the rest, then the middle
            // level could be assumed as 1. Thus, the keys for middle nodes at level 1 will be always be multiples of 16
            const middleLevel = 1
            const middleNodeKey = Math.floor(key / 16) * 16

            // Reset total accumulator every time we start measuring a new middle node
            if (key % 16 === 0) expectedMiddleTotal = 0
            expectedMiddleTotal += value(key)

            assertBn((await tree.nodeAt(middleLevel, middleNodeKey, time)), expectedMiddleTotal, `past value at time ${time} stored in middle node #${middleNodeKey} does not match`)
          }
        })
      })
    })

    context('when the total does overflow', () => {
      const value = MAX_UINT192 // Tree supports registering values with 192 bits max

      it('reverts', async () => {
        const time = 1

        await tree.insert(time, value)
        await assertRevert(tree.insert(time, 1), CHECKPOINT_ERRORS.VALUE_TOO_BIG)
      })
    })
  })

  describe('set', () => {
    beforeEach('init tree', async () => {
      await tree.init()
    })

    context('when the given key is not present in the tree', () => {
      const key = 0
      const time = 2
      const value = 4

      it('reverts', async () => {
        await assertRevert(tree.set(key, time, value), TREE_ERRORS.KEY_DOES_NOT_EXIST)
      })
    })

    context('when the given key is present in the tree', () => {
      context('when having one value', () => {
        const key = 0
        const insertionTime = 2
        const insertedValue = 5
        const setValue = 10

        const itSetsValuesProperly = (setTime, expectedInsertedValue) => {
          beforeEach('insert value and set', async () => {
            await tree.insert(insertionTime, insertedValue)
            await tree.set(key, setTime, setValue)
          })

          it('sets the value of the given key', async () => {
            assertBn((await tree.item(key)), setValue, 'value does not match')
            assertBn((await tree.itemAt(key, 0)), 0, 'initial value does not match')
            assertBn((await tree.itemAt(key, insertionTime)), expectedInsertedValue, 'inserted value does not match')
            assertBn((await tree.itemAt(key, setTime)), setValue, 'set value does not match')
          })

          it('does not affect other keys', async () => {
            assertBn((await tree.item(key + 1)), 0, 'item with key #1 does not match')
          })

          it('does not update the next key or the height of the tree', async () => {
            assertBn((await tree.height()), 1, 'tree height does not match')
            assertBn((await tree.nextKey()), 1, 'next key does not match')
          })

          it('updates the total value stored in the root', async () => {
            assertBn((await tree.total()), setValue, 'last total stored in the root does not match')

            const rootKey = 0
            const rootLevel = await tree.height()
            assertBn((await tree.node(rootLevel, rootKey)), setValue, 'last value stored in the root does not match')
            assertBn((await tree.nodeAt(rootLevel, rootKey, 0)), 0, 'initial value stored in the root does not match')
            assertBn((await tree.nodeAt(rootLevel, rootKey, insertionTime)), expectedInsertedValue, 'value stored in the root at insertion time does not match')
            assertBn((await tree.nodeAt(rootLevel, rootKey, setTime)), setValue, 'value stored in the root at set time does not match')
          })
        }

        context('when the set time is after to the insertion time', () => {
          const setTime = insertionTime + 1
          const expectedInsertedValue = insertedValue

          itSetsValuesProperly(setTime, expectedInsertedValue)
        })

        context('when the set time is equal to the insertion time', () => {
          const setTime = insertionTime
          const expectedInsertedValue = setValue

          itSetsValuesProperly(setTime, expectedInsertedValue)
        })

        context('when the set time is previous to the insertion time', () => {
          const setTime = insertionTime - 1

          it('reverts', async () => {
            await tree.insert(insertionTime, insertedValue)
            await assertRevert(tree.set(key, setTime, setValue), CHECKPOINT_ERRORS.CANNOT_ADD_PAST_VALUE)
          })
        })
      })

      context('when having 40 values', () => {
        const insertionTime = 2
        const setTime = 5

        beforeEach('insert and set 40 values', async () => {
          // First 16 set of children will be         1^0, 1^1, 1^2, ..., 1^15 at time 2
          // Second 16 set of children will be        2^0, 2^1, 2^2, ..., 2^15 at time 2
          // Final 8 set of remaining values will be  3^0, 3^1, 3^2, ..., 3^7 at time 2
          // All values will be incremented by 1 at time 5

          for (let key = 0; key < 40; key++) await tree.insert(insertionTime, value(key))

          assertBn((await tree.height()), 2, 'tree height does not match')
          assertBn((await tree.nextKey()), 40, 'next key does not match')

          for (let key = 0; key < 40; key++) await tree.set(key, setTime, value(key) + 1)
        })

        const value = key => {
          const base = Math.floor(key / 16) + 1
          const exponent = key % 16
          return Math.pow(base, exponent)
        }

        it('does not update the next key and the height of the tree', async () => {
          assertBn((await tree.height()), 2, 'tree height does not match')
          assertBn((await tree.nextKey()), 40, 'next key does not match')
        })

        it('sets the values correctly', async () => {
          for (let key = 0; key < 40; key++) {
            const expectedInsertedValue = value(key)
            const expectedSetValue = expectedInsertedValue + 1

            assertBn((await tree.item(key)), expectedSetValue, 'last value does not match')
            assertBn((await tree.itemAt(key, 0)), 0, 'initial value does not match')
            assertBn((await tree.itemAt(key, insertionTime)), expectedInsertedValue, 'inserted value does not match')
            assertBn((await tree.itemAt(key, setTime)), expectedSetValue, 'set value does not match')
          }
        })

        it('does not affect the next key', async () => {
          const nextKey = await tree.nextKey()
          assertBn((await tree.item(nextKey)), 0, 'value of the next key does not match')
        })

        it('updates the total value stored in the root', async () => {
          const rootKey = 0
          const rootLevel = await tree.heightAt(insertionTime) // Note that height does not change when setting

          let expectedInsertionTotal = 0, expectedSetTotal = 0
          for (let key = 0; key < 40; key++) {
            const insertedValue = value(key)
            expectedInsertionTotal += insertedValue
            expectedSetTotal += (insertedValue + 1)
          }

          assertBn((await tree.total()), expectedSetTotal, 'last total stored in the root does not match')
          assertBn((await tree.nodeAt(rootLevel, rootKey, insertionTime)), expectedInsertionTotal, 'total value stored in the root at insertion time does not match')
          assertBn((await tree.nodeAt(rootLevel, rootKey, setTime)), expectedSetTotal, 'total value stored in the root at set time does not match')
        })

        it('updates the total values stored in the middle nodes', async () => {
          const middleLevel = 1

          const firstMiddleNodeKey = 0
          let firstMidNodeExpectedInsertionTotal = 0, firstMidNodeExpectedSetTotal = 0
          for (let key = 0; key < 16; key++) {
            const insertedValue = value(key)
            firstMidNodeExpectedInsertionTotal += insertedValue
            firstMidNodeExpectedSetTotal += (insertedValue + 1)
          }
          assertBn((await tree.nodeAt(middleLevel, firstMiddleNodeKey, insertionTime)), firstMidNodeExpectedInsertionTotal, `total value at insertion time stored in the first middle node does not match`)
          assertBn((await tree.nodeAt(middleLevel, firstMiddleNodeKey, setTime)), firstMidNodeExpectedSetTotal, `total value at set time stored in the first middle node does not match`)

          const secondMiddleNodeKey = 16
          let secondMidNodeExpectedInsertionTotal = 0, secondMidNodeExpectedSetTotal = 0
          for (let key = 16; key < 32; key++) {
            const insertedValue = value(key)
            secondMidNodeExpectedInsertionTotal += insertedValue
            secondMidNodeExpectedSetTotal += (insertedValue + 1)
          }
          assertBn((await tree.nodeAt(middleLevel, secondMiddleNodeKey, insertionTime)), secondMidNodeExpectedInsertionTotal, `total value at insertion time stored in the second middle node does not match`)
          assertBn((await tree.nodeAt(middleLevel, secondMiddleNodeKey, setTime)), secondMidNodeExpectedSetTotal, `total value at set time stored in the second middle node does not match`)

          const thirdMiddleNodeKey = 32
          let thirdMidNodeExpectedInsertionTotal = 0, thirdMidNodeExpectedSetTotal = 0
          for (let key = 32; key < 40; key++) {
            const insertedValue = value(key)
            thirdMidNodeExpectedInsertionTotal += insertedValue
            thirdMidNodeExpectedSetTotal += (insertedValue + 1)
          }
          assertBn((await tree.nodeAt(middleLevel, thirdMiddleNodeKey, insertionTime)), thirdMidNodeExpectedInsertionTotal, `total value at insertion time stored in the third middle node does not match`)
          assertBn((await tree.nodeAt(middleLevel, thirdMiddleNodeKey, setTime)), thirdMidNodeExpectedSetTotal, `total value at set time stored in the third middle node does not match`)
        })
      })
    })
  })

  describe('update', () => {
    beforeEach('init tree', async () => {
      await tree.init()
    })

    context('when the given key is not present in the tree', () => {
      const key = 0
      const time = 2
      const value = 4

      it('reverts', async () => {
        await assertRevert(tree.update(key, time, value, true), TREE_ERRORS.KEY_DOES_NOT_EXIST)
        await assertRevert(tree.update(key, time, value, false), TREE_ERRORS.KEY_DOES_NOT_EXIST)
      })
    })

    context('when the given key is present in the tree', () => {
      context('when the update overflows', () => {
        const key = 0
        const time = 1

        context('when the first value is small', () => {
          const value = 10

          beforeEach('insert value', async () => {
            await tree.insert(time, value)
          })

          it('reverts', async () => {
            await assertRevert(tree.update(key, time + 1, MAX_UINT256, false), MATH_ERRORS.SUB_UNDERFLOW)
            await assertRevert(tree.update(key, time + 1, value + 1, false), MATH_ERRORS.SUB_UNDERFLOW)
            await assertRevert(tree.update(key, time + 1, MAX_UINT192, true), CHECKPOINT_ERRORS.VALUE_TOO_BIG)
          })
        })

        context('when the first value is huge', () => {
          const value = MAX_UINT192.sub(bn(1))

          beforeEach('insert value', async () => {
            await tree.insert(time, value)
          })

          it('reverts', async () => {
            await assertRevert(tree.update(key, time + 1, 2, true), CHECKPOINT_ERRORS.VALUE_TOO_BIG)
            await assertRevert(tree.update(key, time + 1, MAX_UINT256, true), MATH_ERRORS.ADD_OVERFLOW)
            await assertRevert(tree.update(key, time + 1, MAX_UINT256, false), MATH_ERRORS.SUB_UNDERFLOW)
            await assertRevert(tree.update(key, time + 1, MAX_UINT256.sub(bn(1)), false), MATH_ERRORS.SUB_UNDERFLOW)
          })
        })
      })

      context('when the update does not overflow', () => {
        context('when having one value', () => {
          const key = 0
          const insertionTime = 2
          const insertedValue = 5
          const delta = 3

          context('when the update time is after to the insertion time', () => {
            const updateTime = insertionTime + 1

            const itUpdatesValuesProperly = (updateTime, positive) => {
              beforeEach('insert value and update', async () => {
                await tree.insert(insertionTime, insertedValue)
                await tree.update(key, updateTime, delta, positive)
              })

              it('updates the value of the given key', async () => {
                const expectedUpdatedValue = positive ? insertedValue + delta : insertedValue - delta

                assertBn((await tree.item(key)), expectedUpdatedValue, 'value does not match')
                assertBn((await tree.itemAt(key, 0)), 0, 'initial value does not match')
                assertBn((await tree.itemAt(key, insertionTime)), insertedValue, 'inserted value does not match')
                assertBn((await tree.itemAt(key, updateTime)), expectedUpdatedValue, 'updated value does not match')
              })

              it('does not affect other keys', async () => {
                assertBn((await tree.item(key + 1)), 0, 'item with key #1 does not match')
              })

              it('does not update the next key or the height of the tree', async () => {
                assertBn((await tree.height()), 1, 'tree height does not match')
                assertBn((await tree.nextKey()), 1, 'next key does not match')
              })

              it('updates the total value stored in the root', async () => {
                const expectedUpdatedValue = positive ? insertedValue + delta : insertedValue - delta
                assertBn((await tree.total()), expectedUpdatedValue, 'last total stored in the root does not match')

                const rootKey = 0
                const rootLevel = await tree.height()
                assertBn((await tree.node(rootLevel, rootKey)), expectedUpdatedValue, 'last value stored in the root does not match')
                assertBn((await tree.nodeAt(rootLevel, rootKey, 0)), 0, 'initial value stored in the root does not match')
                assertBn((await tree.nodeAt(rootLevel, rootKey, insertionTime)), insertedValue, 'value stored in the root at insertion time does not match')
                assertBn((await tree.nodeAt(rootLevel, rootKey, updateTime)), expectedUpdatedValue, 'value stored in the root at update time does not match')
              })
            }

            context('when requesting a positive update', () => {
              itUpdatesValuesProperly(updateTime, true)
            })

            context('when requesting a negative update', () => {
              itUpdatesValuesProperly(updateTime, false)
            })
          })

          context('when the update time is equal to the insertion time', () => {
            const updateTime = insertionTime

            const itSetsValuesProperly = (updateTime, positive) => {
              beforeEach('insert value and update', async () => {
                await tree.insert(insertionTime, insertedValue)
                await tree.update(key, updateTime, delta, positive)
              })

              it('updates the value of the given key', async () => {
                const expectedUpdatedValue = positive ? insertedValue + delta : insertedValue - delta

                assertBn((await tree.item(key)), expectedUpdatedValue, 'value does not match')
                assertBn((await tree.itemAt(key, 0)), 0, 'initial value does not match')
                assertBn((await tree.itemAt(key, insertionTime)), expectedUpdatedValue, 'inserted value does not match')
                assertBn((await tree.itemAt(key, updateTime)), expectedUpdatedValue, 'updated value does not match')
              })

              it('does not affect other keys', async () => {
                assertBn((await tree.item(key + 1)), 0, 'item with key #1 does not match')
              })

              it('does not update the next key or the height of the tree', async () => {
                assertBn((await tree.height()), 1, 'tree height does not match')
                assertBn((await tree.nextKey()), 1, 'next key does not match')
              })

              it('updates the total value stored in the root', async () => {
                const expectedUpdatedValue = positive ? insertedValue + delta : insertedValue - delta
                assertBn((await tree.total()), expectedUpdatedValue, 'last total stored in the root does not match')

                const rootKey = 0
                const rootLevel = await tree.height()
                assertBn((await tree.node(rootLevel, rootKey)), expectedUpdatedValue, 'last value stored in the root does not match')
                assertBn((await tree.nodeAt(rootLevel, rootKey, 0)), 0, 'initial value stored in the root does not match')
                assertBn((await tree.nodeAt(rootLevel, rootKey, insertionTime)), expectedUpdatedValue, 'value stored in the root at insertion time does not match')
                assertBn((await tree.nodeAt(rootLevel, rootKey, updateTime)), expectedUpdatedValue, 'value stored in the root at update time does not match')
              })
            }

            context('when requesting a positive update', () => {
              itSetsValuesProperly(updateTime, true)
            })

            context('when requesting a negative update', () => {
              itSetsValuesProperly(updateTime, false)
            })
          })

          context('when the update time is previous to the insertion time', () => {
            const updateTime = insertionTime - 1

            it('reverts', async () => {
              await tree.insert(insertionTime, insertedValue)

              await assertRevert(tree.update(key, updateTime, delta, true), CHECKPOINT_ERRORS.CANNOT_ADD_PAST_VALUE)
              await assertRevert(tree.update(key, updateTime, delta, false), CHECKPOINT_ERRORS.CANNOT_ADD_PAST_VALUE)
            })
          })
        })

        context('when having 40 values', () => {
          const insertionTime = 2
          const updateTime = 5

          beforeEach('insert and update 40 values', async () => {
            // First 16 set of children will be         1^0, 1^1, 1^2, ..., 1^15 at time 2
            // Second 16 set of children will be        2^0, 2^1, 2^2, ..., 2^15 at time 2
            // Final 8 set of remaining values will be  3^0, 3^1, 3^2, ..., 3^7  at time 2
            // All values will be incremented or decremented by 1 at time 5

            for (let key = 0; key < 40; key++) await tree.insert(insertionTime, value(key))

            assertBn((await tree.height()), 2, 'tree height does not match')
            assertBn((await tree.nextKey()), 40, 'next key does not match')

            const delta = 1
            for (let key = 0; key < 40; key++) {
              const positive = key % 2 === 0
              await tree.update(key, updateTime, delta, positive)
            }
          })

          const value = key => {
            const base = Math.floor(key / 16) + 1
            const exponent = key % 16
            return Math.pow(base, exponent)
          }

          it('does not update the next key and the height of the tree', async () => {
            assertBn((await tree.height()), 2, 'tree height does not match')
            assertBn((await tree.nextKey()), 40, 'next key does not match')
          })

          it('updates the values correctly', async () => {
            for (let key = 0; key < 40; key++) {
              const positive = key % 2 === 0
              const expectedInsertedValue = value(key)
              const expectedUpdatedValue = positive ? (expectedInsertedValue + 1) : (expectedInsertedValue - 1)

              assertBn((await tree.item(key)), expectedUpdatedValue, 'last value does not match')
              assertBn((await tree.itemAt(key, 0)), 0, 'initial value does not match')
              assertBn((await tree.itemAt(key, insertionTime)), expectedInsertedValue, 'inserted value does not match')
              assertBn((await tree.itemAt(key, updateTime)), expectedUpdatedValue, 'updated value does not match')
            }
          })

          it('does not affect the next key', async () => {
            const nextKey = await tree.nextKey()
            assertBn((await tree.item(nextKey)), 0, 'value of the next key does not match')
          })

          it('updates the total value stored in the root', async () => {
            const rootKey = 0
            const rootLevel = await tree.heightAt(insertionTime) // Note that height does not change when updating

            let expectedInsertionTotal = 0, expectedSetTotal = 0
            for (let key = 0; key < 40; key++) {
              const positive = key % 2 === 0
              const insertedValue = value(key)

              expectedInsertionTotal += insertedValue
              expectedSetTotal += (positive ? (insertedValue + 1) : (insertedValue - 1))
            }

            assertBn((await tree.total()), expectedSetTotal, 'last total stored in the root does not match')
            assertBn((await tree.nodeAt(rootLevel, rootKey, insertionTime)), expectedInsertionTotal, 'total value stored in the root at insertion time does not match')
            assertBn((await tree.nodeAt(rootLevel, rootKey, updateTime)), expectedSetTotal, 'total value stored in the root at update time does not match')
          })

          it('updates the total values stored in the middle nodes', async () => {
            const middleLevel = 1

            const firstMiddleNodeKey = 0
            let firstMidNodeExpectedInsertionTotal = 0, firstMidNodeExpectedSetTotal = 0
            for (let key = 0; key < 16; key++) {
              const positive = key % 2 === 0
              const insertedValue = value(key)
              firstMidNodeExpectedInsertionTotal += insertedValue
              firstMidNodeExpectedSetTotal += (positive ? (insertedValue + 1) : (insertedValue - 1))
            }
            assertBn((await tree.nodeAt(middleLevel, firstMiddleNodeKey, insertionTime)), firstMidNodeExpectedInsertionTotal, `total value at insertion time stored in the first middle node does not match`)
            assertBn((await tree.nodeAt(middleLevel, firstMiddleNodeKey, updateTime)), firstMidNodeExpectedSetTotal, `total value at update time stored in the first middle node does not match`)

            const secondMiddleNodeKey = 16
            let secondMidNodeExpectedInsertionTotal = 0, secondMidNodeExpectedSetTotal = 0
            for (let key = 16; key < 32; key++) {
              const positive = key % 2 === 0
              const insertedValue = value(key)
              secondMidNodeExpectedInsertionTotal += insertedValue
              secondMidNodeExpectedSetTotal += (positive ? (insertedValue + 1) : (insertedValue - 1))
            }
            assertBn((await tree.nodeAt(middleLevel, secondMiddleNodeKey, insertionTime)), secondMidNodeExpectedInsertionTotal, `total value at insertion time stored in the second middle node does not match`)
            assertBn((await tree.nodeAt(middleLevel, secondMiddleNodeKey, updateTime)), secondMidNodeExpectedSetTotal, `total value at update time stored in the second middle node does not match`)

            const thirdMiddleNodeKey = 32
            let thirdMidNodeExpectedInsertionTotal = 0, thirdMidNodeExpectedSetTotal = 0
            for (let key = 32; key < 40; key++) {
              const positive = key % 2 === 0
              const insertedValue = value(key)
              thirdMidNodeExpectedInsertionTotal += insertedValue
              thirdMidNodeExpectedSetTotal += (positive ? (insertedValue + 1) : (insertedValue - 1))
            }
            assertBn((await tree.nodeAt(middleLevel, thirdMiddleNodeKey, insertionTime)), thirdMidNodeExpectedInsertionTotal, `total value at insertion time stored in the third middle node does not match`)
            assertBn((await tree.nodeAt(middleLevel, thirdMiddleNodeKey, updateTime)), thirdMidNodeExpectedSetTotal, `total value at update time stored in the third middle node does not match`)
          })
        })
      })
    })
  })

  describe('search', () => {
    const insertTime = 10

    beforeEach('init tree', async () => {
      await tree.init()
    })

    context('when searching one value', async () => {
      const value = 15
      const searchValues = [value - 1]

      context('when there was no value inserted in the tree', async () => {
        it('reverts', async () => {
          await assertRevert(tree.search(searchValues, insertTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
        })
      })

      context('when there was one value inserted in the tree', async () => {
        context('when there was a lower value', async () => {
          beforeEach('insert value', async () => {
            await tree.insert(insertTime, value - 1)
          })

          context('when there is no value registered for the given time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })
        })

        context('when there was the same value', async () => {
          beforeEach('insert value', async () => {
            await tree.insert(insertTime, value)
          })

          context('when there is a value registered for a future time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('returns the first item', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 0, 'result key does not match')
              assertBn(values[0], value, 'result value does not match')
            })
          })

          context('when there is a value registered for a past time', async () => {
            const searchTime = insertTime + 1

            it('returns the first item', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 0, 'result key does not match')
              assertBn(values[0], value, 'result value does not match')
            })
          })

          context('when there past, current, and future registered values', async () => {
            const searchTime = insertTime + 1

            beforeEach('update item twice', async () => {
              await tree.update(0, insertTime + 1, 1, true)
              await tree.update(0, insertTime + 2, 1, true)
            })

            it('returns the item matching the searched time', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 0, 'result key does not match')
              assertBn(values[0], value + 1, 'result value does not match')
            })
          })
        })

        context('when there was a higher value', async () => {
          beforeEach('insert value', async () => {
            await tree.insert(insertTime, value + 1)
          })

          context('when there is a value registered for a future time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('returns the first item', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 0, 'result key does not match')
              assertBn(values[0], value + 1, 'result value does not match')
            })
          })

          context('when there is a value registered for a past time', async () => {
            const searchTime = insertTime + 1

            it('returns the first item', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 0, 'result key does not match')
              assertBn(values[0], value + 1, 'result value does not match')
            })
          })
        })
      })

      context('when there were many values inserted in the tree', async () => {
        context('when the total does not reach the searched value', async () => {
          const insertedItems = [3, 4, 2, 1, 2]

          beforeEach('insert values', async () => {
            for (let i = 0; i < insertedItems.length; i++) {
              await tree.insert(insertTime, insertedItems[i])
            }

            assert.isAbove(value, (await tree.totalAt(insertTime)).toNumber(), 'tree total does not match')
          })

          context('when there is no value registered for the given time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })
        })

        context('when the total is equal to the searched value', async () => {
          const insertedItems = [3, 4, 2, 1, 2, 3]

          beforeEach('insert values', async () => {
            for (let i = 0; i < insertedItems.length; i++) {
              await tree.insert(insertTime, insertedItems[i])
            }

            assertBn((await tree.totalAt(insertTime)), value, 'tree total does not match')
          })

          context('when there is no value registered for the given time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('returns the last item', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 5, 'result key does not match')
              assertBn(values[0], 3, 'result value does not match')
            })
          })
        })

        context('when the total is greater than the searched value', async () => {
          const insertedItems = [3, 4, 2, 1, 2, 4, 5, 8, 1]

          beforeEach('insert values', async () => {
            for (let i = 0; i < insertedItems.length; i++) {
              await tree.insert(insertTime, insertedItems[i])
            }

            assert.isAtMost(value, (await tree.totalAt(insertTime)).toNumber(), 'tree total does not match')
          })

          context('when there is no value registered for the given time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('returns the last item', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, 1, 'result keys length does not match')
              assert.equal(values.length, 1, 'result values length does not match')

              assertBn(keys[0], 5, 'result key does not match')
              assertBn(values[0], insertedItems[5], 'result value does not match')
            })
          })
        })
      })
    })

    context('when searching many values', () => {
      context('without checkpointing', async () => {
        context('when all values are included in the tree', () => {
          const searchValues = [0, 4, 7, 17, 21]
          const insertedItems = [2, 1, 4, 1, 8, 6, 7, 1] // total 30

          beforeEach('insert values', async () => {
            for (let i = 0; i < insertedItems.length; i++) {
              await tree.insert(insertTime, insertedItems[i])
            }

            assert.isAtMost(searchValues[searchValues.length - 1], (await tree.totalAt(insertTime)).toNumber(), 'tree total does not match')
          })

          context('when there is no value registered for the given time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('returns the expected items', async () => {
              const { keys, values } = await tree.search(searchValues, searchTime)

              assert.equal(keys.length, searchValues.length, 'result keys length does not match')
              assert.equal(values.length, searchValues.length, 'result values length does not match')

              assertBn(keys[0], 0, 'first result key does not match')
              assertBn(values[0], insertedItems[0], 'first result value does not match')

              assertBn(keys[1], 2, 'second result key does not match')
              assertBn(values[1], insertedItems[2], 'second result value does not match')

              assertBn(keys[2], 3, 'third result key does not match')
              assertBn(values[2], insertedItems[3], 'third result value does not match')

              assertBn(keys[3], 5, 'fourth result key does not match')
              assertBn(values[3], insertedItems[5], 'fourth result value does not match')

              assertBn(keys[4], 5, 'fifth result key does not match')
              assertBn(values[4], insertedItems[5], 'fifth result value does not match')
            })
          })
        })

        context('when some values are not included in the tree', () => {
          const searchValues = [1, 5, 8, 18, 22, 31]
          const insertedItems = [2, 1, 4, 1, 8, 6, 7, 1]

          beforeEach('insert values', async () => {
            for (let i = 0; i < insertedItems.length; i++) {
              await tree.insert(insertTime, insertedItems[i])
            }
          })

          context('when there is no value registered for the given time', async () => {
            const searchTime = insertTime - 1

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })

          context('when there is a value registered for the given time', async () => {
            const searchTime = insertTime

            it('reverts', async () => {
              await assertRevert(tree.search(searchValues, searchTime), TREE_ERRORS.SEARCH_OUT_OF_BOUNDS)
            })
          })
        })
      })

      context('with checkpointing', async () => {
        const initialValue = 10
        const updateTimes = 100

        beforeEach('insert 200 values', async () => {
          for (let i = 0; i < 200; i++) {
            await tree.insert(0, initialValue)
          }
        })

        const updateMany = async key => {
          const initialValue = await tree.itemAt(key, 0)
          for (let time = 1; time <= updateTimes; time++) {
            await tree.set(key, time, initialValue.add(bn(time)))
          }
        }

        const assertCheckpointValues = async key => {
          const initialValue = await tree.itemAt(key, 0)
          for (let time = 0; time <= updateTimes; time++) {
            const value = await tree.itemAt(key, time)
            const expectedValue = initialValue.add(bn(time))
            assertBn(value, expectedValue, `Value at time ${time} does not match`)

            const searchedValue = initialValue.mul(bn(key)).add(value).sub(bn(1))
            const { keys, values } = await tree.search([searchedValue], time)
            assert.equal(keys.length, 1, 'result keys length does not match')
            assert.equal(values.length, 1, 'result values length does not match')
            assertBn(keys[0], key, 'result key does not match')
            assertBn(values[0], expectedValue, 'result value does not match')
          }
        }

        context('when updating the first node many times', async () => {
          const key = 0

          it('handles historic searches properly', async () => {
            await updateMany(key)
            await assertCheckpointValues(key)
          })
        })

        context('when updating a middle node many times', async () => {
          const key = 50

          it('handles historic searches properly', async () => {
            await updateMany(key)
            await assertCheckpointValues(key)
          })
        })

        context('when updating the last node many times', async () => {
          const key = 199

          it('handles historic searches properly', async () => {
            await updateMany(key)
            await assertCheckpointValues(key)
          }).timeout(70000)
        })
      })
    })
  })

  describe('total', () => {
    const time = 0
    const value = 10

    it('holds for a huge tree', async () => {
      const INSERTS = 62
      const REMOVES = 20
      const ITERATIONS = 30

      for (let i = 0; i < ITERATIONS; i++) {
        for (let j = 0; j < INSERTS; j++) await tree.insert(time, value)
        for (let j = 0; j < REMOVES; j++) await tree.set((i * INSERTS) + j, time, 0)
      }

      assertBn(await tree.total(), value * (INSERTS - REMOVES) * ITERATIONS, 'tree total does not match')
    }).timeout(70000)
  })
})
