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
import WebSocket from 'ws';
import fetch from 'node-fetch';
import {
  IVariableAnchorExtData,
  IVariableAnchorPublicInputs,
} from '@webb-tools/interfaces';
import { ChildProcess, spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import JSONStream from 'JSONStream';
import { BigNumber } from 'ethers';

export type WebbRelayerOptions = {
  port: number;
  tmp: boolean;
  configDir: string;
  buildDir?: 'debug' | 'release';
  showLogs?: boolean;
  verbosity?: number;
};

export class WebbRelayer {
  readonly #process: ChildProcess;
  readonly #logs: RawEvent[] = [];
  readonly #eventEmitter = new EventEmitter();
  constructor(private readonly opts: WebbRelayerOptions) {
    const gitRoot = execSync('git rev-parse --show-toplevel').toString().trim();
    const buildDir = opts.buildDir ?? 'debug';
    const verbosity = opts.verbosity ?? 3;
    const levels = ['error', 'warn', 'info', 'debug', 'trace'];
    const logLevel = levels[verbosity] ?? 'debug';
    const relayerPath = `${gitRoot}/target/${buildDir}/webb-relayer`;
    this.#process = spawn(
      relayerPath,
      [
        '-c',
        opts.configDir,
        opts.tmp ? '--tmp' : '',
        `-${'v'.repeat(verbosity)}`,
      ],
      {
        env: {
          ...process.env,
          WEBB_PORT: `${this.opts.port}`,
          RUST_LOG: `webb_probe=${logLevel}`,
        },
      }
    );
    if (this.opts.showLogs) {
      // log that we started
      process.stdout.write(`Webb relayer started on port ${this.opts.port}\n`);
    }
    this.#process.stdout
      ?.pipe(JSONStream.parse())
      .on('data', (parsedLog: UnparsedRawEvent) => {
        if (this.opts.showLogs) {
          process.stdout.write(`${JSON.stringify(parsedLog)}\n`);
        }
        if (parsedLog.target === 'webb_probe') {
          const rawEvent = {
            timestamp: new Date(parsedLog.timestamp),
            ...(parsedLog as any),
          } as RawEvent;
          this.#logs.push(rawEvent);
          this.#eventEmitter.emit(rawEvent.kind, rawEvent);
        }
      });

    this.#process.on('close', (code) => {
      if (this.opts.showLogs) {
        process.stdout.write(
          `Relayer ${this.opts.port} exited with code: ${code}\n`
        );
      }
    });
  }

  public async info(): Promise<WebbRelayerInfo> {
    const endpoint = `http://127.0.0.1:${this.opts.port}/api/v1/info`;
    const response = await fetch(endpoint);
    return response.json() as Promise<WebbRelayerInfo>;
  }
  // data querying api for evm
  public async getLeavesEvm(chainId: string, contractAddress: string) {
    const endpoint = `http://127.0.0.1:${this.opts.port}/api/v1/leaves/evm/${chainId}/${contractAddress}`;
    const response = await fetch(endpoint);
    return response;
  }
  // data querying api for substrate
  public async getLeavesSubstrate(
    chainId: string,
    treeId: string,
    palletId: string
  ) {
    const endpoint = `http://127.0.0.1:${this.opts.port}/api/v1/leaves/substrate/${chainId}/${treeId}/${palletId}`;
    const response = await fetch(endpoint);
    return response;
  }
  public async getEncryptedOutputsEvm(
    chainId: string,
    contractAddress: string
  ) {
    const endpoint = `http://127.0.0.1:${this.opts.port}/api/v1/encrypted_outputs/evm/${chainId}/${contractAddress}`;
    const response = await fetch(endpoint);
    return response;
  }

  public async getMetricsGathered() {
    const endpoint = `http://127.0.0.1:${this.opts.port}/api/v1/metrics`;
    const response = await fetch(endpoint);
    return response;
  }

  public async stop(): Promise<void> {
    this.#process.kill('SIGINT');
  }

  public dumpLogs(): RawEvent[] {
    return this.#logs;
  }

  public clearLogs(): void {
    this.#logs.length = 0;
  }

  public async waitUntilReady(): Promise<void> {
    await this.waitForEvent({ kind: 'lifecycle', event: { started: true } });
  }

  public async waitForEvent(selector: EventSelector): Promise<RawEvent> {
    return new Promise((resolve, _) => {
      const listener = (rawEvent: RawEvent) => {
        const exactSameEvent = Object.keys(selector.event).every((key) => {
          const a = selector.event?.[key];
          const b = rawEvent[key];
          return a === b;
        });
        if (exactSameEvent) {
          // remove listener
          this.#eventEmitter.removeListener(selector.kind, listener);
          resolve(rawEvent);
        }
      };
      // add listener
      this.#eventEmitter.prependListener(selector.kind, listener);
      // first try to find the event in the logs
      const event = this.#logs.find((log) => {
        const isTheSameKind = log.kind === selector.kind;
        const isTheSameEvent = Object.keys(selector.event).every((key) => {
          return selector.event[key] === log[key];
        });

        return isTheSameKind && isTheSameEvent;
      });
      if (event) {
        // remove listener
        this.#eventEmitter.removeListener(selector.kind, listener);
        resolve(event);
      }
    });
  }

  public async ping(): Promise<void> {
    const wsEndpoint = `ws://127.0.0.1:${this.opts.port}/ws`;
    const ws = new WebSocket(wsEndpoint);
    await new Promise((resolve) => ws.once('open', resolve));
    return new Promise(async (resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (data) => {
        const o = JSON.parse(data.toString());
        const msg = parseRelayTxMessage(o);
        if (msg.kind === 'pong') {
          resolve();
        } else {
          reject(new Error(`Unexpected message: ${msg.kind}: ${data}`));
        }
      });
      ws.send(JSON.stringify({ ping: [] }));
    });
  }

  public async vanchorWithdraw(
    chainId: number,
    vanchorAddress: string,
    publicInputs: IVariableAnchorPublicInputs,
    extData: IVariableAnchorExtData
  ): Promise<`0x${string}`> {
    const wsEndpoint = `ws://127.0.0.1:${this.opts.port}/ws`;
    // create a new websocket connection to the relayer.
    const ws = new WebSocket(wsEndpoint);
    await new Promise((resolve) => ws.once('open', resolve));

    const cmd = {
      evm: {
        vAnchor: {
          chainId: chainId,
          id: vanchorAddress,
          extData: {
            recipient: extData.recipient,
            relayer: extData.relayer,
            extAmount: extData.extAmount.replace('0x', '') as any,
            fee: extData.fee.toString() as any,
            refund: extData.refund.toString() as any,
            token: extData.token,
            encryptedOutput1: extData.encryptedOutput1,
            encryptedOutput2: extData.encryptedOutput2,
          },
          proofData: {
            proof: publicInputs.proof,
            extDataHash: publicInputs.extDataHash,
            publicAmount: publicInputs.publicAmount,
            roots: publicInputs.roots,
            outputCommitments: publicInputs.outputCommitments,
            inputNullifiers: publicInputs.inputNullifiers,
          },
        },
      },
    };
    return txHashOrReject(ws, cmd);
  }

  public async substrateMixerWithdraw(inputs: {
    chainId: number;
    id: number;
    proof: number[];
    root: number[];
    nullifierHash: number[];
    recipient: string;
    relayer: string;
    fee: number;
    refund: number;
  }): Promise<`0x${string}`> {
    const wsEndpoint = `ws://127.0.0.1:${this.opts.port}/ws`;
    // create a new websocket connection to the relayer.
    const ws = new WebSocket(wsEndpoint);
    await new Promise((resolve) => ws.once('open', resolve));
    const cmd = {
      substrate: {
        mixer: {
          chainId: inputs.chainId,
          id: inputs.id,
          proof: inputs.proof,
          root: inputs.root,
          nullifierHash: inputs.nullifierHash,
          recipient: inputs.recipient,
          relayer: inputs.relayer,
          fee: inputs.fee,
          refund: inputs.refund,
        },
      },
    };
    return substrateTxHashOrReject(ws, cmd);
  }

  public async substrateAnchorWithdraw(inputs: {
    chainId: number;
    id: number;
    proof: number[];
    roots: number[][];
    nullifierHash: number[];
    recipient: string;
    relayer: string;
    fee: number;
    refund: number;
    refreshCommitment: number[];
    extDataHash: number[];
  }): Promise<`0x${string}`> {
    const wsEndpoint = `ws://127.0.0.1:${this.opts.port}/ws`;
    // create a new websocket connection to the relayer.
    const ws = new WebSocket(wsEndpoint);
    await new Promise((resolve) => ws.once('open', resolve));

    const cmd = {
      substrate: {
        anchor: {
          chainId: inputs.chainId,
          id: inputs.id,
          proof: inputs.proof,
          roots: inputs.roots,
          nullifierHash: inputs.nullifierHash,
          recipient: inputs.recipient,
          relayer: inputs.relayer,
          fee: inputs.fee,
          refund: inputs.refund,
          refreshCommitment: inputs.refreshCommitment,
          extDataHash: inputs.extDataHash,
        },
      },
    };
    return substrateTxHashOrReject(ws, cmd);
  }

  public async substrateVanchorWithdraw(): Promise<void> {}
}

export function calculateRelayerFees(
  denomination: string,
  feePercentage: number
): BigNumber {
  const principleBig = BigNumber.from(denomination);
  const withdrawFeeMill = feePercentage * 1000000;
  const withdrawFeeMillBig = BigNumber.from(withdrawFeeMill);
  const feeBigMill = principleBig.mul(withdrawFeeMillBig);
  const feeBig = feeBigMill.div(BigNumber.from(1000000));
  return feeBig;
}

async function txHashOrReject(ws: WebSocket, cmd: any): Promise<`0x${string}`> {
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      const o = JSON.parse(data.toString());
      const msg = parseRelayTxMessage(o);
      if (msg.kind === 'error') {
        ws.close();
        reject(msg.message);
      } else if (msg.kind === 'pong') {
        ws.close();
        // unreachable.
        reject('unreachable');
      } else if (msg.kind === 'network') {
        const networkError =
          msg.network === 'unsupportedChain' ||
          msg.network === 'unsupportedContract' ||
          msg.network === 'disconnected' ||
          msg.network === 'invalidRelayerAddress';
        const maybeFailed = msg.network as { failed: { reason: string } };
        if (networkError) {
          ws.close();
          reject(msg.network);
        } else if (maybeFailed.failed) {
          ws.close();
          reject(maybeFailed.failed.reason);
        }
      } else if (msg.kind === 'unimplemented') {
        ws.close();
        reject(msg.message);
      } else if (msg.kind === 'unknown') {
        ws.close();
        console.log(o);
        reject('Got unknown response from the relayer!');
      } else if (msg.kind === 'withdraw') {
        const isError =
          msg.withdraw === 'invalidMerkleRoots' ||
          msg.withdraw === 'droppedFromMemPool' ||
          (msg.withdraw as { errored: any }).errored;
        const success = msg.withdraw as {
          finalized: { txHash: `0x${string}` };
        };
        if (isError) {
          ws.close();
          reject(msg.withdraw);
        } else if (success.finalized) {
          ws.close();
          resolve(success.finalized.txHash);
        }
      }
    });

    ws.send(JSON.stringify(cmd));
  });
}

async function substrateTxHashOrReject(
  ws: WebSocket,
  cmd: any
): Promise<`0x${string}`> {
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      const o = JSON.parse(data.toString());
      const msg = parseRelayTxMessage(o);
      if (msg.kind === 'error') {
        ws.close();
        reject(msg.message);
      } else if (msg.kind === 'pong') {
        ws.close();
        // unreachable.
        reject('unreachable');
      } else if (msg.kind === 'network') {
        const networkError =
          msg.network === 'unsupportedChain' ||
          msg.network === 'unsupportedContract' ||
          msg.network === 'disconnected' ||
          msg.network === 'invalidRelayerAddress';
        const maybeFailed = msg.network as { failed: { reason: string } };
        if (networkError) {
          ws.close();
          reject(msg.network);
        } else if (maybeFailed.failed) {
          ws.close();
          reject(maybeFailed.failed.reason);
        }
      } else if (msg.kind === 'unimplemented') {
        ws.close();
        reject(msg.message);
      } else if (msg.kind === 'unknown') {
        ws.close();
        console.log(o);
        reject('Got unknown response from the relayer!');
      } else if (msg.kind === 'withdraw') {
        const isError =
          msg.withdraw === 'invalidMerkleRoots' ||
          msg.withdraw === 'droppedFromMemPool' ||
          (msg.withdraw as { errored: any }).errored;
        const success = msg.withdraw as {
          finalized: { txHash: `0x${string}` };
        };
        if (isError) {
          ws.close();
          reject(msg.withdraw);
        } else if (success.finalized) {
          ws.close();
          resolve(success.finalized.txHash);
        }
      }
    });

    ws.send(JSON.stringify(cmd));
  });
}

interface UnparsedRawEvent {
  timestamp: string;
  target: string;
  kind: string;
  [key: string]: any;
}

export interface RawEvent {
  timestamp: Date;
  level: 'ERROR' | 'INFO' | 'WARN' | 'DEBUG' | 'TRACE';
  kind: EventKind;
  target: EventTarget;
  [key: string]: any;
}

type EventKind =
  | 'lifecycle'
  | 'sync'
  | 'relay_tx'
  | 'signing_backend'
  | 'tx_queue'
  | 'leaves_store'
  | 'signing_backend'
  | 'signature_bridge'
  | 'encrypted_outputs_store';

type EventTarget = 'webb_probe';

export type EventSelector = {
  kind: EventKind;
  event?: any;
};

export interface FeaturesConfig {
  dataQuery?: boolean;
  governanceRelay?: boolean;
  privateTxRelay?: boolean;
}
export interface WithdrawConfig {
  withdrawFeePercentage: number;
  withdrawGaslimit: `0x${string}`;
}

export interface WebbRelayerInfo {
  evm: Evm;
  substrate: Substrate;
}

export interface LeavesCacheResponse {
  leaves: [string];
  last_queried_block: string;
}

export interface EncryptedOutputsCacheResponse {
  encrypted_outputs: [string];
  last_queried_block: string;
}

export interface RelayerMetricResponse {
  metrics: string;
}

export interface Evm {
  [key: string]: ChainInfo;
}

export interface ChainInfo {
  name: string;
  enabled: boolean;
  chainId: number;
  beneficiary?: string;
  contracts: Contract[];
  blockConfirmations: number;
}

export interface Contract {
  contract: ContractKind;
  address: string;
  deployedAt: number;
  eventsWatcher: EventsWatcher;
  size?: number;
  withdrawConfig?: WithdrawConfig;
  proposalSigningBackend?: ProposalSigningBackend;
  linkedAnchors?: LinkedAnchor[];
}

export interface EventsWatcher {
  enabled: boolean;
  pollingInterval: number;
  printProgressInterval?: number;
}

export type RawResourceId = {
  type: 'Raw';
  resourceId: string;
};

export type EvmLinkedAnchor = {
  type: 'Evm';
  chainId: string;
  address: string;
};

export type SubstrateLinkedAnchor = {
  type: 'Substrate';
  chainId: number;
  pallet: number;
  treeId: number;
};
export type LinkedAnchor =
  | RawResourceId
  | EvmLinkedAnchor
  | SubstrateLinkedAnchor;

export interface Substrate {
  [key: string]: NodeInfo;
}

export interface NodeInfo {
  enabled: boolean;
  runtime: RuntimeKind;
  pallets: Pallet[];
}

export interface Pallet {
  pallet: PalletKind;
  eventsWatcher: EventsWatcher;
  proposalSigningBackend?: ProposalSigningBackend;
  linkedAnchors?: LinkedAnchor[];
}

export interface EnabledContracts {
  contract: ContractKind;
}

// Default WithdrawlConfig for the contracts.
export const defaultWithdrawConfigValue: WithdrawConfig = {
  withdrawGaslimit: '0x5B8D80',
  withdrawFeePercentage: 0,
};

type ContractKind =
  | 'Anchor'
  | 'SignatureBridge'
  | 'GovernanceBravoDelegate'
  | 'VAnchor';
type RuntimeKind = 'DKG' | 'WebbProtocol';
type PalletKind =
  | 'DKG'
  | 'DKGProposals'
  | 'DKGProposalHandler'
  | 'AnchorBn254'
  | 'VAnchorBn254'
  | 'SignatureBridge';

export type DKGProposalSigningBackend = {
  type: 'DKGNode';
  node: string;
}; /** DKG Node name in the config */
export type MockedProposalSigningBackend = {
  type: 'Mocked';
  privateKey: string;
}; /** Signer private key */
export type ProposalSigningBackend =
  | DKGProposalSigningBackend
  | MockedProposalSigningBackend;

type PongMessage = {
  kind: 'pong';
};

type NetworkMessage = {
  kind: 'network';
} & {
  network:
    | 'connecting'
    | 'connected'
    | { failed: { reason: string } }
    | 'disconnected'
    | 'unsupportedContract'
    | 'unsupportedChain'
    | 'invalidRelayerAddress';
};

type WithdrawMessage = {
  kind: 'withdraw';
} & {
  withdraw:
    | 'sent'
    | { submitted: { txHash: string } }
    | { finalized: { txHash: string } }
    | 'valid'
    | 'invalidMerkleRoots'
    | 'droppedFromMemPool'
    | { errored: { code: number; reason: string } };
};

type ErrorMessage = {
  kind: 'error';
} & { message: string };

type UnimplementedMessage = {
  kind: 'unimplemented';
} & { message: string };

type ParsedRelayerMessage =
  | PongMessage
  | NetworkMessage
  | WithdrawMessage
  | ErrorMessage
  | UnimplementedMessage
  | { kind: 'unknown' };

function parseRelayTxMessage(o: any): ParsedRelayerMessage {
  if (o.pong) {
    return { kind: 'pong' };
  } else if (o.network) {
    return {
      kind: 'network',
      network: o.network,
    };
  } else if (o.withdraw) {
    return {
      kind: 'withdraw',
      withdraw: o.withdraw,
    };
  } else if (o.error) {
    return {
      kind: 'error',
      message: o.error,
    };
  } else if (o.unimplemented) {
    return {
      kind: 'unimplemented',
      message: o.unimplemented,
    };
  } else {
    return { kind: 'unknown' };
  }
}
