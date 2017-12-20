import {
  RTCPeerConnection,
  RTCMediaStream,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  MediaStreamTrack,
  getUserMedia,
} from 'react-native-webrtc';


var EventEmitter = require('events').EventEmitter;
var assign = require('object-assign');


function stopTrack(tracks) {
    return; // dont stop
    
  if (tracks && tracks.length) {
    for (i = 0; i<tracks.length; i++) {
      tracks[i].stop();
    }
  }
}

var CallFlow = function(config) {
  config = config || {};
  this.firebaseRootRef = config.firebaseRef;
  if (config.authenticator) {
    this.authenticator = config.authenticator;
  }

  if (config.callRef) {
    this.callRef = config.callRef;
    this.signallingRef = this.firebaseRootRef.child('signalling/' + this.callRef.key);
    this.iceRef = this.firebaseRootRef.child('ice/' + this.callRef.key);
  }
  if (config.callLogRef) {
    this.callLogRef = config.callLogRef;
  }

  if (config.localMsisdn) {
    this.localMsisdn = config.localMsisdn;
  } else if (this.authenticator) {
    this.localMsisdn = this.authenticator.getMsisdn();
  }
  if (config.remoteMsisdn) {
    this.toMsisdn = config.remoteMsisdn.replace(/^\+/, '');
  }

  if (config.terminalId) {
    this.terminalId = config.terminalId;
  }

  if (config.localStream) {
    this.localStream = config.localStream;
  } else {
    this.localStream = null;
  }

  this.callState = '';
  this.pc_config = {"iceServers": [{"url": "stun:stun.l.google.com:19302"}]};
  this.mediaConnected = false;
  this.mediaConnectedTime = null;
  this.mediaDisconnectedTime = this.mediaConnectedTime;
  this.errorCb = function(error) {
    if (error) {
      console.log('RTCPeerConnection error ' + error);
      this.emit('error', this, error);
    }
  }.bind(this);
  this.transfer2phoneOngoing = false;
  this.transferOngoing = false;
  this.remoteSdp = null;
  this.remoteAllowsVideo = false;
  this.hasSipSDPOffer = false;
};

CallFlow.prototype = assign({}, EventEmitter.prototype, {
  getCallId: function() {
    return this.callRef.key;
  },

  getLocalMsisdn: function() {
    return this.localMsisdn;
  },

  getRemoteAllowsVideo: function() {
    return this.remoteAllowsVideo;
  },

  getRemoteMsisdn: function() {
    return this.toMsisdn;
  },

  getRole: function() {
    return this.role;
  },

  getState: function() {
    return this.callState;
  },
  getLocalMediaStream: function() {
    return this.localStream;
  },
  getRemoteMediaStream: function() {
    return this.remoteMediaStream;
  },
  requestTurnCredentials: function(cbFunc, arg, callNodeExists) {
    var turnRef = this.firebaseRootRef.child('turn/request').push();
    turnRef.set({'msisdn': this.localMsisdn});
    this.emit('stateChange', this, 'turn');
    this.firebaseRootRef.child('turn/response').child(turnRef.key).on('value',
      function(servers) {
        if (!servers.val()) {
          return;
        }
        this.pc_config = servers.val();
        this.emit('stateChange', this, 'precheck');
        if (!callNodeExists) {
          cbFunc(arg);
        } else {
          this.callRef.child('callstate').once('value', function(s) {
            var v = s.val();
            if (!v || v.state !== 'ended') {
              this.callState = v ? v.state : 'initial';
              this.emit('stateChange', this, this.callState);
              cbFunc(arg);
            } else {
              console.log('Call already ended');
              this.emit('stateChange', this, 'ended');
            }
          }.bind(this));
        }
      }.bind(this));

  },
  observeIncomingCall: function() {
    this.observeOngoingCall();
    this.callLogRef.update({
      startedAt: {".sv":"timestamp"},
      type: "incomingcall",
      remoteMsisdn: this.toMsisdn,
      callref: this.callRef.key
    });
    this.signallingRef.push({
      fromMsisdn: this.localMsisdn,
      fromTerminalId: this.terminalId,
      timestamp: {".sv":"timestamp"},
      type: 'ringing'
    });
  },
  observeOngoingCall: function() {
    this.role = 'observer';
    console.log('Become observer, handle signals');
    this.signallingRef.off();
    this.signallingRef.on('child_added', this.onSignalling.bind(this));
  },
  makeCall: function() {
    this.role = 'caller';
    this.callState = 'calling';
    this.emit('stateChange', this, this.callState);
    this.callLogRef.update({
      startedAt: {".sv":"timestamp"},
      type: "outgoingcall",
      remoteMsisdn: this.toMsisdn,
      callref: this.callRef.key
    });
    console.log("callref.Key[" + this.callRef.key + "]");
    this.requestTurnCredentials(this.doMakeCall.bind(this), 'offer', false);
  },
  hasOngoingTransfer: function() {
    return (this.transferOngoing || this.transfer2phoneOngoing);
  },
  transferCall: function(media) {
    if (this.hasOngoingTransfer()) {
      console.log('Transfer in progress, try afterwards');
      return false;
    }

    console.log('transfer call. Media is : ', media);

    var userMedia = {"audio": true};
    if (media == 'video') {
      userMedia = {"audio": true, "video":true};
    }

    getUserMedia(userMedia, function(stream) {

      this.dropPc();

      this.localStream = stream;
      this.role = 'caller';
      this.setInternalCallState('transfer');
      this.requestTurnCredentials(this.doTransferCall.bind(this), true);
    }.bind(this), function() {
      var error = 'User has denied permission for audio';
      this.emit('mediaPermissionError', this, error);
    }.bind(this));
    return true;
  },

  enableVideo: function(enableVideo) {
    if (this.hasOngoingTransfer()) {
      console.log('Transfer in progress, try afterwards');
      return false;
    }
    console.log("enableVideo : ", enableVideo);
    var media = {"audio": true};
    if (enableVideo) {
      console.log("Now I will try to enable video....");
      media = {"audio": true, "video":true};
    }
    getUserMedia(media, function(stream) {

      this.dropPc();

      // getUserMedia will not trigger the errorCallback if it can partly
      // fulfill the request, so we need to check if we got video
      if (enableVideo) {
        var videoTracks = stream.getVideoTracks();
        if (videoTracks && videoTracks.length) {
          console.log('Video was enabled in browser');
          this.markCallAsVideo();
        } else {
          var error = 'User has denied permission for audio or video';
          console.log(error);
          this.emit('mediaPermissionError', this, error);
          return false;
        }
      }

      if (this.localStream) {
        stopTrack(this.localStream.getAudioTracks());
        stopTrack(this.localStream.getVideoTracks());
      }

      this.localStream = stream;
      this.role = 'caller';
      this.setInternalCallState('transfer');
      this.requestTurnCredentials(this.doTransferCall.bind(this), true);

    }.bind(this), function() {
      var error = 'User has denied permission for audio or video';
      console.log(error);
      this.emit('mediaPermissionError', this, error);
    }.bind(this));
    return true;
  },
    publishCandidate: function(event) {
        candidate = event.candidate
        if (!candidate || !candidate.candidate) {
            return;
        }
        this.iceRef.child(this.getUfrag(candidate.candidate)).push({
            fromMsisdn: this.localMsisdn,
            fromTerminalId: this.terminalId,
            timestamp: {".sv":"timestamp"},
            type: 'ice',
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            candidate: candidate.candidate
        });

    },
  doMakeCall: function() {
    this.startPeerConnection(true, function(desc) {
      if (this.pc !== null && this.callState !== 'ended') {
        this.pc.setLocalDescription(new RTCSessionDescription(desc), function() {
          console.log('offer setLocalDescription success');
          if (this.callState === 'ended') {
            console.log('CallState == ended, ignore new offer sdp');
            return;
          }
          var callRequest = {
            fromMsisdn: this.localMsisdn,
            toMsisdn: this.toMsisdn,
            callstate: {state: 'initial'}
          };
          this.callRef.set(callRequest);
          this.markConnection();
          console.log('Do Make call, handle signals');
          this.signallingRef.on('child_added', this.onSignalling.bind(this));
          this.signallingRef.push({
            fromMsisdn: this.localMsisdn,
            fromTerminalId: this.terminalId,
            timestamp: {".sv":"timestamp"},
            sdp: desc.sdp,
            type: 'offer',
            capabilities: {video:true}
          });
        }.bind(this), this.errorCb);
      }
    }.bind(this),
    this.publishCandidate.bind(this));
  },
  getUfrag: function(sdp) {
      const regex =/^.*ufrag[ :](\S+)\s.*/gm;
      let m;
      
      if ((m = regex.exec(sdp)) !== null) {
          return "-" + m[1].replace(/\//g, "-");
      }
      console.error('no ufrag in sdp=', sdp);
      return "notfound";
  },
  doTransferCall: function() {
    this.startPeerConnection(true, function(desc) {
      if (this.pc !== null && this.callState !== 'ended') {
        this.pc.setLocalDescription(new RTCSessionDescription(desc), function() {
          console.log('transferCall offer setLocalDescription success');
          if (this.callState === 'ended') {
            console.log('CallState == ended, ignore transfer sdp');
            return;
          }
          this.markConnection();
          this.signallingRef.push({
            fromMsisdn: this.localMsisdn,
            fromTerminalId: this.terminalId,
            timestamp: {".sv":"timestamp"},
            sdp: desc.sdp,
            type: 'transfer',
            capabilities: {video:true}
          });
        }.bind(this), this.errorCb);
      }
    }.bind(this),
    this.publishCandidate.bind(this));
  },

  removeConnection: function() {
    if (this.connectionRef) {
      this.connectionRef.onDisconnect().cancel();
      this.connectionRef.set('disconnected');
      this.connectionRef = null;
    }
  },

  markConnection: function() {
    this.removeConnection();
    var newConnectionRef = this.firebaseRootRef.child('webconnections').child(this.callRef.key).push();
    newConnectionRef.set({'terminal': this.terminalId, 'status': 'connected', 'msisdn': this.localMsisdn});
    this.connectionRef = newConnectionRef.child('status');
    /* not implemented this.connectionRef.onDisconnect().set('dangling');*/
  },

  answerCall: function(media) {
    console.log('Answer call with media : ', media);
    var userMedia = {"audio": true};
    if (media == 'video') {
      userMedia = {"audio": true, "video":true};
    }
    getUserMedia(userMedia, function(stream) {

      // getUserMedia will not trigger the errorCallback if it can partly
      // fulfill the request, so we need to check if we got video
      if (media == 'video') {
        var videoTracks = stream.getVideoTracks();
        if (videoTracks && videoTracks.length) {
          console.log('Video was enabled in browser');
        } else {
          var error = 'User has denied permission for video';
          console.log(error);
          this.emit('mediaPermissionError', this, error);
          return false;
        }
      }
      this.localStream = stream;
      this.role = 'answerer';
      this.callLogRef.update({startedAt: {".sv":"timestamp"}});
      this.signallingRef.off();
      this.markConnection();
      this.requestTurnCredentials(this.doAnswerCall.bind(this), null, true);
    }.bind(this), function() {
      var error = 'User has denied permission for media';
      this.emit('mediaPermissionError', this, error);
    }.bind(this));
  },

  doAnswerCall: function() {
    console.log('Do answer call, handle signals');
    this.signallingRef.on('child_added', this.onSignalling.bind(this));
  },

  endCall: function() {
    this.endCallWithReason(null);
  },

  endCallWithReason: function(reason) {
    var byeSignal = {
      fromMsisdn: this.localMsisdn,
      fromTerminalId: 'any',
      timestamp: {".sv":"timestamp"},
      type: 'bye'
    };
    if (reason !== null) {
      byeSignal.reason = reason;
    }
    this.signallingRef.push(byeSignal);
    this.removeConnection();
    if (this.callLogRef) {
      this.callLogRef.update({endedAt: {".sv":"timestamp"}});
    }
  },

  pushToPhone: function() {
    if (this.hasOngoingTransfer()) {
      console.log('Transfer in progress, try afterwards');
      return false;
    }
    this.signallingRef.push({
      fromMsisdn: this.localMsisdn,
      fromTerminalId: this.terminalId,
      timestamp: {".sv":"timestamp"},
      type: 'transfer2phone'
    });
    return true;
  },
  markCallAsVideo: function() {
    this.callRef.child('usedVideo').set(true);
  },
  addStatsKey: function(key) {
    this.callRef.child('statsKey').set(key);
  },
  onSignalling: function(snap) {
    var v = snap.val();
    if (!v) return;
    if ((v.fromTerminalId === this.terminalId && (v.type !== 'bye')) || !this.terminalId) return;

    console.log('SIGNAL: %s', JSON.stringify(v, undefined, 2));
    if (this.callState === 'ended') {
      return;
    }
    if (v.type === 'transferMcu') {
       this.talkingToMcu = true;
    }
    if (v.type === 'offer' && this.role === 'answerer') {
      this.setCallState('initial');
      this.hasSipSDPOffer = this.checkForSipSDP(v);
      if (v.capabilities && v.capabilities.video) {
        this.remoteAllowsVideo = true;
      } else {
        this.remoteAllowsVideo = false;
      }
      if (this.hasSipSDPOffer) {
        this.requestSip2WebrtcSDP(this.handleOffer.bind(this), v.sdp);
      } else {
        this.handleOffer(v);
      }
    }
    if (v.type === 'answer' && this.role === 'caller') {
      if (this.talkingToMcu) {
        return;
      }
      this.setCallState('connected');
      this.handleAnswer(v);
      if (v.capabilities && v.capabilities.video) {
        this.remoteAllowsVideo = true;
      } else {
        this.remoteAllowsVideo = false;
      }
    }
    if ((v.type === 'answerMcu') && this.role === 'caller') {
      this.setCallState('connected');
      this.handleAnswer(v);
      if (v.capabilities && v.capabilities.video) {
        this.remoteAllowsVideo = true;
      } else {
        this.remoteAllowsVideo = false;
      }
    }
    if (v.type === 'ringing' && this.role === 'caller') {
      this.emit('stateChange', this, 'ringing');
      this.handleRinging(v);
    }
    if (v.type === 'ack') {
      console.log('handling ack signal, role = ', this.role);
      this.setCallState('connected');
      this.transferOngoing = false;
      if (this.role === 'answerer') {
        this.handleAck(v);
      } else if (this.role === 'observer') {
        this.setInternalCallState('connected-elsewhere');
      }
    }
    if (v.type === 'transfer' && !this.talkingToMcu) {
      this.handleTransfer(v);
      if (v.capabilities && v.capabilities.video) {
        this.remoteAllowsVideo = true;
      } else {
        this.remoteAllowsVideo = false;
      }
    }
    if (v.type === 'transferMcu') {
      this.handleTransfer(v);
      if (v.capabilities && v.capabilities.video) {
        this.remoteAllowsVideo = true;
      } else {
        this.remoteAllowsVideo = false;
      }
    }
    if (v.type === 'transfer2phone') {
      this.handleTransfer2Phone(v);
    }
    if (v.type === 'reject-transfer2phone') {
      this.handleRejectTransfer2Phone(v);
    }
    if (v.type === 'bye') {
      this.setCallState('ended', v.reason);
      this.handleBye();
    }
  },
  handleRejectTransfer2Phone: function(signal) {
    this.transfer2phoneOngoing = false;
  },
  handleTransfer2Phone: function(signal) {
    this.transfer2phoneOngoing = true;
  },

  handleBrokenConnection: function() {
    console.log('Signalling connection broken, ending call');
    setTimeout(function() {
      this.setCallState('ended', 'Connection Broken');
      this.signallingRef.push({
        fromMsisdn: this.localMsisdn,
        fromTerminalId: this.terminalId,
        timestamp: {".sv":"timestamp"},
        type: 'bye',
        'reason': 'Connection Broken'
      });
    }.bind(this), 0);
  },

  getTurnCredentialsAndTransfer: function(transferSignal) {
    var turnRef = this.firebaseRootRef.child('turn/request').push();
    turnRef.set({'msisdn': this.localMsisdn});
    console.log('Retreive new turn credentials');
    this.firebaseRootRef.child('turn/response').child(turnRef.key).on('value',
      function(servers) {
        if (!servers.val()) {
          return;
        }
        console.log('Got new turn credentials');
        this.pc_config = servers.val();
        this.hasSipSDPOffer = this.checkForSipSDP(transferSignal);
        if (this.hasSipSDPOffer) {
          this.requestSip2WebrtcSDP(this.handleOffer.bind(this), transferSignal.sdp);
        } else {
          this.handleOffer(transferSignal);
        }
      }.bind(this));
  },

  handleTransfer: function(transfer) {
    this.transferOngoing = true;
    this.transfer2phoneOngoing = false;
    if (this.localMsisdn === transfer.fromMsisdn) {
      // my side of the call is transferred
      if (this.role === 'answerer' || this.role === 'caller') {
        // i was answerer - drop my connection
        this.removeConnection();
        this.dropPc();
        this.role = 'observer';
        this.setInternalCallState('transferred-elsewhere');
      }
    } else {
      // remote side of the call moved
      if (this.role !== 'observer') {
        this.role = 'answerer';
        this.dropPc(true);
        this.getTurnCredentialsAndTransfer(transfer);
      }
    }
  },
  setInternalCallState: function(state) {
    this.setCallState(state, '', true);
  },

  setCallState: function(state, reason, internalState) {
    try {
      if (this.callState !== 'ended') {
        this.callState = state;
        if (state === 'ended' && reason) {
          if (!internalState) {
            this.callRef.child('callstate').set({state: state, reason: reason});
          }
          this.emit('stateChange', this, state, reason);
        } else {
          if (!internalState) {
            this.callRef.child('callstate').set({state: state});
          }
          setTimeout(function() {
            this.emit('stateChange', this, state);
          }.bind(this), 0);
        }
      }
    } catch (err) {
      console.log('failed to set state %s with error %s', state, err);
    }
  },
  closePc : function() {
    if (this.pc) {
      try {
        this.pc.oniceconnectionstatechange = function(e) {};
        this.pc.close();
        this.pc.onaddstream = function() {};
      }
      catch(e) {
        console.log(e);
      }
    }
  },

  dropPc: function(preserveLocalStream) {
    this.closePc();
    if (this.localStream && !preserveLocalStream) {
      stopTrack(this.localStream.getAudioTracks());
      stopTrack(this.localStream.getVideoTracks());
      this.localStream = null;
    }
    this.pc = null;
    console.log('Cleared peerconnection');
  },

  handleBye: function() {
    this.removeConnection();
    this.dropPc();
    this.firebaseRootRef
      .child('incoming')
      .child(this.localMsisdn)
      .remove();
    this.firebaseRootRef
      .child('outgoing')
      .child(this.localMsisdn)
      .remove();
    this.iceRef.removeAll();
    this.iceRef.off();
  },
  handleAnswer: function(answer) {
    if (this.remoteSdp) {
      console.log('setRemoteDescription already called, ignore answer signal');
      return;
    }
    var sdp = {sdp: answer.sdp, type: 'answer'};
    this.remoteUfrag = this.getUfrag(answer.sdp);
    console.log('remote ufrag=', this.remoteUfrag);
    this.pc.setRemoteDescription(new RTCSessionDescription(sdp), function() {
        console.log('answer setRemoteDescription success');
        this.setupIceListener()
    }.bind(this), this.errorCb);
    this.remoteSdp = sdp;
    this.remoteTerminalId = answer.fromTerminalId;
    console.log('talking to remote terminal %s', this.remoteTerminalId);
    this.signallingRef.push({
      fromMsisdn: this.localMsisdn,
      fromTerminalId: this.terminalId,
      timestamp: {".sv":"timestamp"},
      ackedTerminalId: answer.fromTerminalId,
      type: 'ack'
    });
    console.log('PeerConnection signaling state %s', this.pc.signalingState);
  },
  handleRinging: function(ringing) {
    if (!ringing.sdp || this.hasPranswer) {
      return;
    }
    return;
    // cant set early media before
    // https://code.google.com/p/webrtc/issues/detail?id=3530 is fixed
    /*
     this.hasPranswer = true;
     var sdp = { sdp: ringing.sdp, type:'pranswer'};
     this.pc.setRemoteDescription(new RTCSessionDescription(sdp), this.errorCb);
     */
  },
  handleAck: function(ack) {
    if (this.terminalId === ack.ackedTerminalId) {
      this.remoteTerminalId = ack.fromTerminalId;
      console.log('i am acked: talking to remote terminal %s', this.remoteTerminalId);
    } else {
      if (this.pc) {
        this.removeConnection();
        this.closePc();
      }
      this.pc = null;
      // to set state of transfer button right
      //this.setCallState('connected');
      this.role = 'observer';
      this.setInternalCallState('transferred-elsewhere');
    }
  },

  checkForSipSDP: function(v) {
    return (v.sdp.indexOf('RTP/SAVPF') === -1);
  },

  requestSip2WebrtcSDP: function(cbFunc, sdp) {
    var sdpRef = this.firebaseRootRef.child('sdp');
    var sdpRequestRef = sdpRef.child('request').child(this.callRef.key).push();
    var sdpResponseRef = sdpRef.child('response').child(this.callRef.key).child(sdpRequestRef.key);

    sdpRequestRef.set({'sdp': sdp, type: 'sip2webrtc', isOffer: true});
    var onValueChange = sdpResponseRef.on('value', function(s) {
        if (!s.val()) {
          return;
        }
        if (s.hasChild('sdp')) {
          sdpResponseRef.off('value', onValueChange);
          cbFunc(s.val());
        }
      }.bind(this));
  },
  requestWebrtc2SipSDP: function(cbFunc, sdp) {
    var sdpRef = this.firebaseRootRef.child('sdp');
    var sdpRequestRef = sdpRef.child('request').child(this.callRef.key).push();
    var sdpResponseRef = sdpRef.child('response').child(this.callRef.key).child(sdpRequestRef.key);

    sdpRequestRef.set({'sdp': sdp, type: 'webrtc2sip', isOffer: false});
    var onValueChange = sdpResponseRef.on('value', function(s) {
        if (!s.val()) {
          return;
        }
        if (s.hasChild('sdp')) {
          sdpResponseRef.off('value', onValueChange);
          cbFunc(s.val());
        }
      }.bind(this));
  },

  handleOffer: function(v) {
    var patchedSdp = v.sdp.replace('a=setup:active', 'a=setup:actpass');
    var offer = {sdp: patchedSdp, type: 'offer'};
    this.startPeerConnection(false, function(desc) {
      if (this.pc !== null && this.callState !== 'ended') {
        this.pc.setLocalDescription(new RTCSessionDescription(desc), function() {
          if (this.callState === 'ended') {
            console.log('Call state ended, ignore the offer sdp.');
            return;
          }
          console.log('answer setLocalDescription success');
          var answerSignal = {
                fromMsisdn: this.localMsisdn,
                fromTerminalId: this.terminalId,
                timestamp: {".sv":"timestamp"},
                sdp: desc.sdp,
                type: 'answer',
                capabilities: {video:true}
              };
          if (this.hasSipSDPOffer) {
            this.requestWebrtc2SipSDP(function(p) {
              answerSignal.sdp = p.sdp;
              this.signallingRef.push(answerSignal);
            }.bind(this), desc.sdp);
          } else {
            this.signallingRef.push(answerSignal);
          }
          this.setupIceListener();
        }.bind(this), this.errorCb);
      }
    }.bind(this),
    this.publishCandidate.bind(this),
    offer);
  },
    setupIceListener: function() {
        console.log('Listen for remote ufrag=', this.remoteUfrag);
        this.iceRef.child(this.remoteUfrag).on('child_added',
                                               function(v) {
                                                   if (v.val()) {
                                                       console.log(v.val());
                                                       this.handleIce(v.val());
                                                   }
                                               }.bind(this));
    },
  handleIce: function(iceCand) {
    if (iceCand.fromTerminalId === this.terminalId) {
      console.log('ignore my own candidate');
      return;
    }
    this.pc.addIceCandidate(new RTCIceCandidate({
      sdpMid: iceCand.sdpMid,
      sdpMLineIndex: iceCand.sdpMLineIndex,
      candidate: iceCand.candidate
    }));
  },

  setRemoteStreamCapability: function() {
    if (!this.remoteSdp) return;

    var regex = /m=video [1-9]/;
    this.remoteMediaStream.hasVideo = regex.test(this.remoteSdp.sdp);
  },

  mediaGotConnected: function() {
    if (!this.mediaConnected) {
      this.mediaConnected = true;
      if (!this.mediaConnectedTime) {
        this.mediaConnectedTime = new Date();
      }
      if (this.callLogRef) {
        this.callLogRef.child('media/start').once('value', function(s) {
          if (!s.val()) {
            this.callLogRef.child('media').update({start: this.mediaConnectedTime.getTime()});
          }
        }.bind(this));
      }
      this.emit('stateChange', this, this.callState);
    }
  },

startPeerConnection: function(isCaller, callbackSdp, callbackCand, offer) {
    if (this.callState === 'ended') {
      console.log('Call state ended, ignore call to startPeerConnection');
      return;
    }
    if (RTCPeerConnection.generateCertificate) {
      RTCPeerConnection.generateCertificate({
        name: "ECDSA",
        namedCurve: "P-256"
      }).then(function(cert) {
        this.pc_config.certificates = [cert];
        console.log(this.pc_config);
        this.pc = new RTCPeerConnection(this.pc_config);
        console.log('this.pc', this.pc);
        this.setupPeerConnection(isCaller, callbackSdp, callbackCand, offer);
      }.bind(this));
    } else {
      this.pc = new RTCPeerConnection(this.pc_config);
      this.setupPeerConnection(isCaller, callbackSdp, callbackCand, offer);
    }
  },

  setupPeerConnection: function(isCaller, callbackSdp, callbackCand, offer) {
    if (this.callState === 'ended') {
      console.log('Call state ended, ignore call to setupPeerConnection');
      return;
    }

    this.pc.onicecandidate = callbackCand; //ice candidates callback
    // Disable getstats. TODO pickup new version
    /*
    var session = getstats.newSession('5569db7f-6fd2-4eb9-9473-03f1557d120a', this.callRef.key, this.localMsisdn);
    session.collectStats(this.pc, this.toMsisdn);
    session.onCallIDChange = function (callId) {
      this.addStatsKey(callId);
    }.bind(this);
    */
    this.pc.onaddstream = function(e) {
      this.remoteMediaStream = e.stream;
      this.setRemoteStreamCapability();
    }.bind(this);

    this.pc.addStream(this.localStream);

    var sdpConstraints = {
            optional: [],
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

    if (isCaller) {
      this.remoteSdp = null;
      this.pc.createOffer(callbackSdp, this.errorCb, sdpConstraints);
    } else {
        this.remoteUfrag = this.getUfrag(offer.sdp);
        console.log('remote ufrag=', this.remoteUfrag);
      this.pc.setRemoteDescription(new RTCSessionDescription(offer), function() {
        console.log('offer setRemoteDescription success');
        this.remoteSdp = offer;
        this.pc.createAnswer(callbackSdp, this.errorCb, sdpConstraints);
      }.bind(this), this.errorCb);
    }

    this.pc.onsignalingstatechange = function() {
      if (this.pc) {
        console.log('signalling state %s', this.pc.signalingState);
      }
    }.bind(this);

    this.pc.oniceconnectionstatechange = function(e) {
      var target = e.srcElement; // Chrome style
      if (!target) {
        // Firefox has a different event parameter.
        target = e.target;
      }
      var connectionState = target.iceConnectionState;
      console.log('ice connection state %s', connectionState);
      if (this.mediaConnected === false && (connectionState === "connected" || connectionState === "completed")) {
        this.mediaGotConnected();
      } else if (connectionState === "disconnectedZZZ" || connectionState === "closed") {
          // TODO: ZZZ when call is transferred on the other side this side's PC sees connectionstate
          // change to the disconnected, thus commented out for now
        this.mediaConnected = false;
        this.mediaDisconnectedTime = new Date();
        if (this.callLogRef) {
          this.callLogRef.child('media').update({end: this.mediaDisconnectedTime.getTime()});
        }
        this.emit('stateChange', this, this.callState);
        setTimeout(function () {
          console.log('RTCPeerConnection connection closed. ending call');
          this.endCall();
        }.bind(this), 0);
      } else if (connectionState === "failed") {
        // End the call, which is stuck in failed state.
        setTimeout(function() {
          console.log('Ice connection failed. ending call');
          this.endCallWithReason('Ice connection failed');
        }.bind(this), 0);
      }
    }.bind(this);
  },
  canTransfer: function() {
    if (this.callState === 'connected-elsewhere' || this.callState === 'transferred-elsewhere') {
      return !this.pc;
    } else {
      return false;
    }
  },
  pressDtmf: function(nr) {
    var dtmfRef = this.firebaseRootRef
      .child('dtmf')
      .child(this.getCallId());
    dtmfRef.push({signal: nr, duration: 120});
  },
  sendFeedback: function (goodQuality, remarks) {
    this.signallingRef.push({
      fromMsisdn: this.localMsisdn,
      fromTerminalId: this.terminalId,
      goodQuality: goodQuality,
      remarks: remarks || 'none',
      type: 'feedback'
    });
    console.log('Send feedback ', goodQuality, remarks);
  },
  createCallLog: function() {
    console.log('createCallLog', this.callLogRef.toString());
    this.callLogRef.update({
      startedAt: {".sv":"timestamp"},
      type: 'incomingcall',
      remoteMsisdn: this.toMsisdn,
      callref: this.callRef.key
    });
  }

});

module.exports = CallFlow;
