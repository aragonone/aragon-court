const { assertRevert } = require('@aragon/os/test/helpers/assertThrow')
const { soliditySha3 } = require('web3-utils')

const TokenFactory = artifacts.require('TokenFactory')
const CourtMock = artifacts.require('CourtMock')
const CRVoting = artifacts.require('CRVoting')
const SumTree = artifacts.require('HexSumTreeWrapper')

const MINIME = 'MiniMeToken'

const getLog = (receipt, logName, argName) => {
  const log = receipt.logs.find(({ event }) => event == logName)
  return log ? log.args[argName] : null
}

const getLogCount = (receipt, logName) => {
  const logs = receipt.logs.filter(l => l.event == logName)
  return logs.length
}

const deployedContract = async (receiptPromise, name) =>
      artifacts.require(name).at(getLog(await receiptPromise, 'Deployed', 'addr'))

const assertEqualBN = async (actualPromise, expected, message) =>
      assert.equal((await actualPromise).toNumber(), expected, message)

const assertLogs = async (receiptPromise, ...logNames) => {
  const receipt = await receiptPromise
  for (const logName of logNames) {
    assert.isNotNull(getLog(receipt, logName), `Expected ${logName} in receipt`)
  }
}

contract('Court: final appeal', ([ poor, rich, governor, juror1, juror2, juror3, juror4, juror5, juror6, juror7 ]) => {
  const jurors = [juror1, juror2, juror3, juror4, juror5, juror6, juror7]
  const NO_DATA = ''
  const ZERO_ADDRESS = '0x' + '00'.repeat(20)
  let MAX_JURORS_PER_BATCH
  let MAX_DRAFT_ROUNDS

  const termDuration = 10
  const firstTermStart = 1
  const jurorMinStake = 400
  const startBlock = 1000
  const commitTerms = 1
  const revealTerms = 1
  const appealTerms = 1
  const penaltyPct = 100 // 100‱ = 1%

  const initialBalance = 1e6
  const richStake = 1000
  const jurorGenericStake = 500

  const NEW_DISPUTE_EVENT = 'NewDispute'
  const JUROR_DRAFTED_EVENT = 'JurorDrafted'
  const DISPUTE_STATE_CHANGED_EVENT = 'DisputeStateChanged'
  const VOTE_COMMITTED_EVENT = 'VoteCommitted'
  const VOTE_REVEALED_EVENT = 'VoteRevealed'
  const RULING_APPEALED_EVENT = 'RulingAppealed'
  const ROUND_SLASHING_SETTLED_EVENT = 'RoundSlashingSettled'

  const ERROR_INVALID_ADJUDICATION_STATE = 'COURT_INVALID_ADJUDICATION_STATE'

  const SALT = soliditySha3('passw0rd')

  const encryptVote = (ruling, salt = SALT) =>
        soliditySha3(
          { t: 'uint8', v: ruling },
          { t: 'bytes32', v: salt }
        )

  const pct4 = (n, p) => n * p / 1e4

  before(async () => {
    this.tokenFactory = await TokenFactory.new()
  })

  beforeEach(async () => {
    // Mints 1,000,000 tokens for sender
    this.anj = await deployedContract(this.tokenFactory.newToken('ANJ', initialBalance, { from: rich }), MINIME)
    await assertEqualBN(this.anj.balanceOf(rich), initialBalance, 'rich balance')
    await assertEqualBN(this.anj.balanceOf(poor), 0, 'poor balance')

    const initPwd = SALT
    const preOwner = '0x' + soliditySha3(initPwd).slice(-40)
    this.voting = await CRVoting.new(preOwner)
    this.sumTree = await SumTree.new(preOwner)

    this.court = await CourtMock.new(
      termDuration,
      this.anj.address,
      ZERO_ADDRESS, // no fees
      this.voting.address,
      this.sumTree.address,
      initPwd,
      0,
      0,
      0,
      0,
      0,
      governor,
      firstTermStart,
      jurorMinStake,
      [ commitTerms, appealTerms, revealTerms ],
      penaltyPct
    )

    MAX_JURORS_PER_BATCH = (await this.court.getMaxJurorsPerBatch.call()).toNumber()
    MAX_DRAFT_ROUNDS = (await this.court.getMaxDraftRounds.call()).toNumber()

    await this.court.mock_setBlockNumber(startBlock)
    // tree searches always return jurors in the order that they were added to the tree
    await this.court.mock_hijackTreeSearch()

    assert.equal(await this.court.token(), this.anj.address, 'court token')
    //assert.equal(await this.court.jurorToken(), this.anj.address, 'court juror token')
    await assertEqualBN(this.court.mock_treeTotalSum(), 0, 'empty sum tree')

    await this.anj.approveAndCall(this.court.address, richStake, NO_DATA, { from: rich })

    for (let juror of jurors) {
      await this.anj.approve(this.court.address, jurorGenericStake, { from: rich })
      await this.court.stakeFor(juror, jurorGenericStake, NO_DATA, { from: rich })
    }

    await assertEqualBN(this.court.totalStakedFor(rich), richStake, 'rich stake')
    for (let juror of jurors) {
      await assertEqualBN(this.court.totalStakedFor(juror), jurorGenericStake, 'juror stake')
    }
  })

  const passTerms = async terms => {
    await this.court.mock_timeTravel(terms * termDuration)
    await this.court.heartbeat(terms)
    await this.court.mock_blockTravel(1)
    assert.isFalse(await this.court.canTransitionTerm(), 'all terms transitioned')
  }

  context('Final appeal', () => {

    const jurorNumber = 3
    const term = 3
    const rulings = 2

    let disputeId = 0
    const firstRoundId = 0
    let voteId

    beforeEach(async () => {
      for (const juror of jurors) {
        await this.court.activate({ from: juror })
      }
      await passTerms(1) // term = 1

      const arbitrable = poor // it doesn't matter, just an address
      const receipt = await this.court.createDispute(arbitrable, rulings, jurorNumber, term)
      await assertLogs(receipt, NEW_DISPUTE_EVENT)
      disputeId = getLog(receipt, NEW_DISPUTE_EVENT, 'disputeId')
      voteId = getLog(receipt, NEW_DISPUTE_EVENT, 'voteId')
    })

    const draftAdjudicationRound = async (roundJurors) => {
      let roundJurorsDrafted = 0
      let draftReceipt
      while (roundJurorsDrafted < roundJurors) {
        draftReceipt = await this.court.draftAdjudicationRound(disputeId)
        const callJurorsDrafted = getLogCount(draftReceipt, JUROR_DRAFTED_EVENT)
        roundJurorsDrafted += callJurorsDrafted
      }
      await assertLogs(draftReceipt, DISPUTE_STATE_CHANGED_EVENT)
    }

    const moveForwardToFinalRound = async () => {
      await passTerms(2) // term = 3, dispute init

      for (let roundId = 0; roundId < MAX_DRAFT_ROUNDS; roundId++) {
        const roundJurors = (2**roundId) * jurorNumber + 2**roundId - 1
        // draft
        await draftAdjudicationRound(roundJurors)

        // commit
        await passTerms(commitTerms)

        // reveal
        await passTerms(revealTerms)

        // appeal
        const appealReceipt = await this.court.appealRuling(disputeId, roundId)
        assertLogs(appealReceipt, RULING_APPEALED_EVENT)
        voteId = getLog(appealReceipt, RULING_APPEALED_EVENT, 'voteId')
        await passTerms(appealTerms)
      }
    }

    it('reaches final appeal, all jurors can vote', async () => {
      await moveForwardToFinalRound()
      const vote = 1
      for (const juror of jurors) {
        const receiptPromise = await this.voting.commitVote(voteId, encryptVote(vote), { from: juror })
        await assertLogs(receiptPromise, VOTE_COMMITTED_EVENT)
      }
    })

    it('fails appealing after final appeal', async () => {
      await moveForwardToFinalRound()

      const roundJurors = (await this.sumTree.getNextKey()).toNumber() - 1
      // no need to draft (as it's all jurors)

      // commit
      await passTerms(commitTerms)

      // reveal
      await passTerms(revealTerms)

      // appeal
      await assertRevert(this.court.appealRuling(disputeId, MAX_DRAFT_ROUNDS), ERROR_INVALID_ADJUDICATION_STATE)
    })

  })
})
