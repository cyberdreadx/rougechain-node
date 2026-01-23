// WebRTC Peer Connection Manager
// Handles direct peer-to-peer connections using WebRTC Data Channels

import type { PeerInfo, P2PMessage, ConnectionState } from './types';

type MessageHandler = (message: P2PMessage) => void;
type StateChangeHandler = (peerId: string, state: ConnectionState) => void;

interface PeerConnection {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: ConnectionState;
  peerInfo: Partial<PeerInfo>;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export class PeerConnectionManager {
  private peers: Map<string, PeerConnection> = new Map();
  private messageHandlers: Set<MessageHandler> = new Set();
  private stateHandlers: Set<StateChangeHandler> = new Set();
  private localPeerId: string;
  private onIceCandidate: ((peerId: string, candidate: RTCIceCandidate) => void) | null = null;
  private onOffer: ((peerId: string, offer: RTCSessionDescriptionInit) => void) | null = null;
  private onAnswer: ((peerId: string, answer: RTCSessionDescriptionInit) => void) | null = null;

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
  }

  setSignalingHandlers(handlers: {
    onIceCandidate: (peerId: string, candidate: RTCIceCandidate) => void;
    onOffer: (peerId: string, offer: RTCSessionDescriptionInit) => void;
    onAnswer: (peerId: string, answer: RTCSessionDescriptionInit) => void;
  }) {
    this.onIceCandidate = handlers.onIceCandidate;
    this.onOffer = handlers.onOffer;
    this.onAnswer = handlers.onAnswer;
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler) {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private notifyStateChange(peerId: string, state: ConnectionState) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.state = state;
    }
    this.stateHandlers.forEach(handler => handler(peerId, state));
  }

  private handleMessage(message: P2PMessage) {
    this.messageHandlers.forEach(handler => handler(message));
  }

  private createConnection(peerId: string): RTCPeerConnection {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    connection.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(peerId, event.candidate);
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'connected') {
        this.notifyStateChange(peerId, 'connected');
      } else if (state === 'disconnected' || state === 'closed') {
        this.notifyStateChange(peerId, 'disconnected');
      } else if (state === 'failed') {
        this.notifyStateChange(peerId, 'failed');
      }
    };

    connection.ondatachannel = (event) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        this.setupDataChannel(peerId, event.channel);
      }
    };

    return connection;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.dataChannel = channel;

    channel.onopen = () => {
      console.log(`[P2P] Data channel opened with ${peerId}`);
      this.notifyStateChange(peerId, 'connected');
    };

    channel.onclose = () => {
      console.log(`[P2P] Data channel closed with ${peerId}`);
      this.notifyStateChange(peerId, 'disconnected');
    };

    channel.onerror = (error) => {
      console.error(`[P2P] Data channel error with ${peerId}:`, error);
      this.notifyStateChange(peerId, 'failed');
    };

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as P2PMessage;
        this.handleMessage(message);
      } catch (error) {
        console.error('[P2P] Failed to parse message:', error);
      }
    };
  }

  async initiateConnection(peerId: string): Promise<void> {
    if (this.peers.has(peerId)) {
      console.log(`[P2P] Already connected to ${peerId}`);
      return;
    }

    this.notifyStateChange(peerId, 'connecting');
    
    const connection = this.createConnection(peerId);
    const dataChannel = connection.createDataChannel('rougechain', {
      ordered: true,
    });

    this.peers.set(peerId, {
      peerId,
      connection,
      dataChannel: null,
      state: 'connecting',
      peerInfo: { peerId },
    });

    this.setupDataChannel(peerId, dataChannel);

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      
      if (this.onOffer) {
        this.onOffer(peerId, offer);
      }
    } catch (error) {
      console.error(`[P2P] Failed to create offer for ${peerId}:`, error);
      this.notifyStateChange(peerId, 'failed');
    }
  }

  async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    let peer = this.peers.get(peerId);
    
    if (!peer) {
      const connection = this.createConnection(peerId);
      peer = {
        peerId,
        connection,
        dataChannel: null,
        state: 'connecting',
        peerInfo: { peerId },
      };
      this.peers.set(peerId, peer);
    }

    try {
      await peer.connection.setRemoteDescription(offer);
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      
      if (this.onAnswer) {
        this.onAnswer(peerId, answer);
      }
    } catch (error) {
      console.error(`[P2P] Failed to handle offer from ${peerId}:`, error);
      this.notifyStateChange(peerId, 'failed');
    }
  }

  async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`[P2P] No connection found for ${peerId}`);
      return;
    }

    try {
      await peer.connection.setRemoteDescription(answer);
    } catch (error) {
      console.error(`[P2P] Failed to handle answer from ${peerId}:`, error);
    }
  }

  async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`[P2P] No connection found for ${peerId}`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (error) {
      console.error(`[P2P] Failed to add ICE candidate for ${peerId}:`, error);
    }
  }

  sendMessage(peerId: string, message: P2PMessage): boolean {
    const peer = this.peers.get(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') {
      console.warn(`[P2P] Cannot send to ${peerId}: channel not open`);
      return false;
    }

    try {
      peer.dataChannel.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`[P2P] Failed to send message to ${peerId}:`, error);
      return false;
    }
  }

  broadcast(message: P2PMessage): number {
    let sent = 0;
    this.peers.forEach((peer) => {
      if (this.sendMessage(peer.peerId, message)) {
        sent++;
      }
    });
    return sent;
  }

  getConnectedPeers(): PeerInfo[] {
    const connected: PeerInfo[] = [];
    this.peers.forEach((peer) => {
      if (peer.state === 'connected') {
        connected.push({
          peerId: peer.peerId,
          publicKey: peer.peerInfo.publicKey || '',
          nodeRole: peer.peerInfo.nodeRole || 'full-node',
          connectionState: peer.state,
          latency: peer.peerInfo.latency || 0,
          lastSeen: peer.peerInfo.lastSeen || Date.now(),
          chainHeight: peer.peerInfo.chainHeight || 0,
          version: peer.peerInfo.version || '1.0.0',
        });
      }
    });
    return connected;
  }

  updatePeerInfo(peerId: string, info: Partial<PeerInfo>) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.peerInfo = { ...peer.peerInfo, ...info };
    }
  }

  disconnect(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(peerId);
      this.notifyStateChange(peerId, 'disconnected');
    }
  }

  disconnectAll() {
    this.peers.forEach((_, peerId) => this.disconnect(peerId));
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  getConnectedCount(): number {
    let count = 0;
    this.peers.forEach((peer) => {
      if (peer.state === 'connected') count++;
    });
    return count;
  }
}
