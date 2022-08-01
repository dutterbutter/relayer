/*
 * Copyright 2022 Webb Technologies Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import temp from 'temp';
import fs from 'fs';
import { ethers } from 'ethers';
import { u8aToHex } from '@polkadot/util';
import { DeployerConfig } from '@webb-tools/interfaces';
import { GovernedTokenWrapper } from '@webb-tools/tokens';
import { VBridge } from '@webb-tools/vbridge';
import { LocalChain } from '../lib/localTestnet.js';
import { LocalDkg } from '../lib/localDkg.js';
import { Pallet, WebbRelayer, EnabledContracts } from '../lib/webbRelayer.js';
import {
  defaultEventsWatcherValue,
  UsageMode,
} from '../lib/substrateNodeBase.js';
import { ethAddressFromUncompressedPublicKey } from '../lib/ethHelperFunctions.js';
import path from 'path';
import getPort, { portNumbers } from 'get-port';
import { CircomUtxo, parseTypedChainId } from '@webb-tools/sdk-core';
import assert from 'assert';
/**
 * The main entry file for the Webb Relayer Simulation:
 *
 * It would does the following:
 *
 * 1. Start DKG System (3 nodes { Alice, Bob and Charlie })
 * 2. Start Three EVM Local Chain (Hermes, Athena and Demeter)
 * 3. Deploy the VAnchor and Signautre Bridge contracts on the local EVM chains.
 * 4. Setup the Configurations for the Relayer.
 * 5. Start the Relayer.
 * 6. Start the Simulation, which includes:
 *   a. Create a new transact call for the VAnchor on a _random_ local EVM chain.
 *   b. wait for the relayer to see this transaction.
 *   c. wait for the other two chains to have the updated Merkle Root.
 *   d. go to step (a) again.
 * */

// Global Variables shared across the script
const SIMULATION_DURATION = 10 * 60 * 1000; // 10 minutes
const PK1 = u8aToHex(ethers.utils.randomBytes(32));
const PK2 = u8aToHex(ethers.utils.randomBytes(32));
const PK3 = u8aToHex(ethers.utils.randomBytes(32));
const tmpDirPath = temp.mkdirSync('webb');

// local evm network
let hermesChain: LocalChain;
let athenaChain: LocalChain;
let demeterChain: LocalChain;

let vbridge: VBridge;
// dkg nodes
let aliceNode: LocalDkg;
let bobNode: LocalDkg;
let charlieNode: LocalDkg;

let webbRelayer: WebbRelayer;

async function main(): Promise<void> {
  console.log('Starting the DKG System');
  // Start the dkg system
  await startDkgSystem();
  console.log('Starting the Local EVM Network');
  // Start the local EVM network
  await startLocalEvmNetwork();
  console.log('Deploying VAnchor and Signature Bridge Contracts');
  // Deploy the VAnchor and Signautre Bridge contracts on the local EVM chains.
  await deployWebbContracts();
  console.log('Starting the Webb Relayer');
  // Setup the Configurations for the Relayer.
  await saveRelayerConfig();
  await prepareChains();
  // Start the Relayer.
  await startRelayer();
  // Start the Simulation:
  const simulationStats = {
    totalTransactions: 0,
    totalTransactionsSuccess: 0,
    totalTransactionsFailure: 0,
    startedAt: new Date(),
    lastTransactionDuration: 0,
  };
  console.log('Starting the Simulation');
  console.table(simulationStats);
  // get a random local EVM chain
  const chains = [hermesChain, athenaChain, demeterChain];
  const leavesCache: Record<number, Uint8Array[]> = {
    [hermesChain.chainId]: [],
    [athenaChain.chainId]: [],
    [demeterChain.chainId]: [],
  };
  const pickRandomChain = () =>
    chains[Math.floor(Math.random() * chains.length)]!;
  while (true) {
    // pick a random local EVM chain
    const srcChain = pickRandomChain();
    // another random local EVM chain
    const dstChain = chains.filter((c) => c !== srcChain)[0]!;
    // create a new transaction for the VAnchor on a _random_ local EVM chain.
    const targetVAnchor = vbridge.getVAnchor(srcChain.chainId);

    const leavesMapBeforeDeposit: Record<number, Uint8Array[]> = {
      [srcChain.chainId]: leavesCache[srcChain.chainId]!,
      [dstChain.chainId]: leavesCache[dstChain.chainId]!,
    };
    const outputUtxo = await CircomUtxo.generateUtxo({
      backend: 'Circom',
      curve: 'Bn254',
      chainId: dstChain.chainId.toString(),
      originChainId: srcChain.chainId.toString(),
      amount: '10000000',
    });

    const dummyOutput1 = await CircomUtxo.generateUtxo({
      backend: 'Circom',
      curve: 'Bn254',
      chainId: srcChain.chainId.toString(),
      originChainId: srcChain.chainId.toString(),
      amount: '0',
    });

    const tx = await targetVAnchor.transactWrap(
      '0x0000000000000000000000000000000000000000',
      [],
      [outputUtxo, dummyOutput1],
      0,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      leavesMapBeforeDeposit
    );
    simulationStats.totalTransactions++;
    console.log(`Sent transaction ${tx.transactionHash}`);
    // Store the leaves.
    leavesCache[srcChain.chainId]!.push(
      outputUtxo.commitment,
      dummyOutput1.commitment
    );

    const latestDepositRoot = await targetVAnchor.contract.getLastRoot();
    const timer = performance.now();
    await webbRelayer.waitForEvent({
      kind: 'tx_queue',
      event: {
        ty: 'EVM',
        chain_id: dstChain.underlyingChainId.toString(),
        pending: true,
      },
    });

    // now we wait for the tx queue on that chain to execute the transaction.
    await webbRelayer.waitForEvent({
      kind: 'tx_queue',
      event: {
        ty: 'EVM',
        chain_id: dstChain.underlyingChainId.toString(),
        finalized: true,
      },
    });
    const txTime = performance.now() - timer;
    // now query the dstChain's VAnchor to see if the Merkle Root has been updated.
    const dstVAnchor = vbridge.getVAnchor(dstChain.chainId);
    const edgeIndex = await dstVAnchor.contract.edgeIndex(srcChain.chainId);
    const edgeList = await dstVAnchor.contract.edgeList(edgeIndex);
    // then we do check if the Merkle Root has been updated.
    // if it has, then we continue to the next iteration.
    const valueUtxoIndex = leavesCache[srcChain.chainId]?.length ?? 0;
    if (valueUtxoIndex != 0 && edgeList.root != latestDepositRoot) {
      simulationStats.totalTransactionsFailure++;
      console.error(
        `failed to relay the transaction #${simulationStats.totalTransactions}
        total failure: ${simulationStats.totalTransactionsFailure}`
      );
      console.table(simulationStats);
      continue;
    } else {
      simulationStats.totalTransactionsSuccess++;
      simulationStats.lastTransactionDuration = txTime;
      console.log(
        `successfully relayed the transaction #${simulationStats.totalTransactions}
        total success: ${simulationStats.totalTransactionsSuccess}`
      );
      console.table(simulationStats);
    }

    // check if the simulation is done.
    if (
      simulationStats.startedAt.getTime() + SIMULATION_DURATION <
      Date.now()
    ) {
      break;
    }
  }
  // finally
  await teardown();
}

async function startDkgSystem(): Promise<void> {
  const usageMode: UsageMode = {
    mode: 'host',
    nodePath: path.resolve(
      '../../dkg-substrate/target/release/dkg-standalone-node'
    ),
  };
  const enabledPallets: Pallet[] = [
    {
      pallet: 'DKGProposalHandler',
      eventsWatcher: defaultEventsWatcherValue,
    },
  ];
  aliceNode = await LocalDkg.start({
    name: 'substrate-alice',
    authority: 'alice',
    usageMode,
    ports: 'auto',
    enabledPallets,
  });

  bobNode = await LocalDkg.start({
    name: 'substrate-bob',
    authority: 'bob',
    usageMode,
    ports: 'auto',
    enabledPallets,
  });

  charlieNode = await LocalDkg.start({
    name: 'substrate-charlie',
    authority: 'charlie',
    usageMode,
    ports: 'auto',
    enableLogging: false,
    enabledPallets,
  });

  // we need to wait until the public key is on chain.
  await charlieNode.waitForEvent({
    section: 'dkg',
    method: 'PublicKeySubmitted',
  });
}

async function startLocalEvmNetwork(): Promise<void> {
  const randomPort = () => getPort({ port: portNumbers(3333, 4444) });
  const enabledContracts: EnabledContracts[] = [
    {
      contract: 'VAnchor',
    },
  ];
  const populatedAccounts = [
    {
      secretKey: PK1,
      balance: ethers.utils.parseEther('1000').toHexString(),
    },
    {
      secretKey: PK2,
      balance: ethers.utils.parseEther('1000').toHexString(),
    },
    {
      secretKey: PK3,
      balance: ethers.utils.parseEther('1000').toHexString(),
    },
  ];

  hermesChain = new LocalChain({
    name: 'Hermes',
    port: await randomPort(),
    chainId: 5001,
    populatedAccounts,
    enabledContracts,
  });

  athenaChain = new LocalChain({
    name: 'Athena',
    port: await randomPort(),
    chainId: 5002,
    populatedAccounts,
    enabledContracts,
  });

  demeterChain = new LocalChain({
    name: 'Demeter',
    port: await randomPort(),
    chainId: 5003,
    populatedAccounts,
    enabledContracts,
  });
}

async function deployWebbContracts(): Promise<void> {
  const wallets = [
    new ethers.Wallet(PK1, hermesChain.provider()),
    new ethers.Wallet(PK2, athenaChain.provider()),
    new ethers.Wallet(PK3, demeterChain.provider()),
  ];

  const deployers: DeployerConfig = {
    [hermesChain.chainId]: wallets[0]!,
    [athenaChain.chainId]: wallets[1]!,
    [demeterChain.chainId]: wallets[2]!,
  };

  const tokens: Record<number, string[]> = {
    [hermesChain.chainId]: ['0'],
    [athenaChain.chainId]: ['0'],
    [demeterChain.chainId]: ['0'],
  };


  // fetch the dkg public key.
  const dkgPublicKey = await charlieNode.fetchDkgPublicKey();
  assert(dkgPublicKey !== null, 'dkg public key is null');
  const governorAddress = ethAddressFromUncompressedPublicKey(dkgPublicKey!);
  // verify the governor address is a valid ethereum address.
  assert(
    ethers.utils.isAddress(governorAddress),
    'governor address is invalid'
  );

  const governorConfig: Record<number, string> = {
    [hermesChain.chainId]: governorAddress,
    [athenaChain.chainId]: governorAddress,
    [demeterChain.chainId]: governorAddress,
  };

  vbridge = await deploySignatureVBridge(tokens, deployers, governorConfig);
}

async function fetchComponentsFromFilePaths(
  wasmPath: string,
  witnessCalculatorPath: string,
  zkeyPath: string
) {
  const wasm: Buffer = fs.readFileSync(path.resolve(wasmPath));
  const witnessCalculatorGenerator = await import(witnessCalculatorPath);
  const witnessCalculator = await witnessCalculatorGenerator.default(wasm);
  const zkeyBuffer: Buffer = fs.readFileSync(path.resolve(zkeyPath));
  const zkey: Uint8Array = new Uint8Array(
    zkeyBuffer.buffer.slice(
      zkeyBuffer.byteOffset,
      zkeyBuffer.byteOffset + zkeyBuffer.byteLength
    )
  );

  return {
    wasm,
    witnessCalculator,
    zkey,
  };
}

async function deploySignatureVBridge(
  tokens: Record<number, string[]>,
  deployers: DeployerConfig,
  governorConfig: Record<number, string>,
): Promise<VBridge> {
  let assetRecord: Record<number, string[]> = {};
  let chainIdsArray: number[] = [];
  let existingWebbTokens = new Map<number, GovernedTokenWrapper>();

  for (const chainIdType of Object.keys(deployers)) {
    assetRecord[chainIdType] = tokens[chainIdType];
    chainIdsArray.push(Number(chainIdType));
    governorConfig[Number(chainIdType)] = deployers[chainIdType];
    existingWebbTokens[chainIdType] = null;
  }

  const bridgeInput = {
    vAnchorInputs: {
      asset: assetRecord,
    },
    chainIDs: chainIdsArray,
    webbTokens: existingWebbTokens,
  };

  const zkComponentsSmall = await fetchComponentsFromFilePaths(
    path.resolve(
      `./protocol-solidity-fixtures/fixtures/vanchor_2/8/poseidon_vanchor_2_8.wasm`
    ),
    path.resolve(
      `./protocol-solidity-fixtures/fixtures/vanchor_2/8/witness_calculator.cjs`
    ),
    path.resolve(
      `./protocol-solidity-fixtures/fixtures/vanchor_2/8/circuit_final.zkey`
    )
  );
  const zkComponentsLarge = await fetchComponentsFromFilePaths(
    path.resolve(
      `./protocol-solidity-fixtures/fixtures/vanchor_16/8/poseidon_vanchor_16_8.wasm`
    ),
    path.resolve(
      `./protocol-solidity-fixtures/fixtures/vanchor_16/8/witness_calculator.cjs`
    ),
    path.resolve(
      `./protocol-solidity-fixtures/fixtures/vanchor_16/8/circuit_final.zkey`
    )
  );

  return VBridge.deployVariableAnchorBridge(
    bridgeInput,
    deployers,
    governorConfig as any,
    zkComponentsSmall,
    zkComponentsLarge
  );
}

async function saveRelayerConfig(): Promise<void> {
  // get chainId
  const chainId = await charlieNode.getChainId();
  // Save the configration to the config file
  await charlieNode.writeConfig(`${tmpDirPath}/${charlieNode.name}.json`, {
    suri: '//Charlie',
    chainId,
  });
  await hermesChain.writeConfig(`${tmpDirPath}/${hermesChain.name}.json`, {
    signatureVBridge: vbridge,
    proposalSigningBackend: { type: 'DKGNode', node: chainId.toString() },
  });
  await athenaChain.writeConfig(`${tmpDirPath}/${athenaChain.name}.json`, {
    signatureVBridge: vbridge,
    proposalSigningBackend: { type: 'DKGNode', node: chainId.toString() },
  });
  await demeterChain.writeConfig(`${tmpDirPath}/${demeterChain.name}.json`, {
    signatureVBridge: vbridge,
    proposalSigningBackend: { type: 'DKGNode', node: chainId.toString() },
  });
  console.log(`Config files saved to ${tmpDirPath}`);
}

async function prepareChains(): Promise<void> {
  const api = await charlieNode.api();
  const chainIds = Array.from(vbridge.vBridgeSides.keys())
    .map((v) => parseTypedChainId(v))
    .map((v) => v.chainId);
  const rids = await Promise.all(
    Array.from(vbridge.vAnchors.values()).map((v) => v.createResourceId())
  );
  const setResourceCall = (resourceId: string) =>
    api.tx.dkgProposals.setResource(resourceId, '0x00');
  const whitlelistChainIdCall = (chainId: number) =>
    api.tx.dkgProposals.whitelistChain({ Evm: chainId });
  for (const rid of rids) {
    await charlieNode.sudoExecuteTransaction(setResourceCall(rid));
  }

  for (const chainId of chainIds) {
    await charlieNode.sudoExecuteTransaction(whitlelistChainIdCall(chainId));
  }
}

async function startRelayer(): Promise<void> {
  // now start the relayer
  const relayerPort = await getPort({ port: portNumbers(9955, 9999) });
  webbRelayer = new WebbRelayer({
    port: relayerPort,
    tmp: true,
    configDir: tmpDirPath,
    showLogs: true,
    verbosity: 3,
  });

  await webbRelayer.waitUntilReady();
}

async function teardown(): Promise<void> {
  await webbRelayer.stop();

  await aliceNode.stop();
  await bobNode.stop();
  await charlieNode.stop();

  await hermesChain.stop();
  await athenaChain.stop();
  await demeterChain.stop();
}

main().catch(console.error);
