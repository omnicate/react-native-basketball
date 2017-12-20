import React, {
  Component,
} from 'react';
import {
  StyleSheet,
  View,
  Dimensions,
  Platform,
} from 'react-native';

import Ball from './components/Ball';
import Hoop from './components/Hoop';
import Net from './components/Net';
import Floor from './components/Floor';
import Emoji from './components/Emoji';
import Score from './components/Score';
import {
  RTCPeerConnection,
  RTCMediaStream,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  MediaStreamTrack,
  getUserMedia,
} from 'react-native-webrtc';

import Vector from './utils/Vector';
import ContactsWrapper from 'react-native-contacts-wrapper';
import {setJSExceptionHandler, getJSExceptionHandler} from 'react-native-exception-handler';

// physical variables
const gravity = 0.6; // gravity
const radius = 48; // ball radius
const rotationFactor = 10; // ball rotation factor

// components sizes and positions
const FLOOR_HEIGHT = 48;
const FLOOR_Y = 11;
const HOOP_Y = Dimensions.get('window').height - 227;
const NET_HEIGHT = 6;
const NET_WIDTH = 83;
const NET_Y = Dimensions.get('window').height - 216;
const NET_X = (Dimensions.get('window').width / 2) - (NET_WIDTH / 2);
const NET_LEFT_BORDER_X = NET_X + NET_HEIGHT / 2;
const NET_LEFT_BORDER_Y = NET_Y;
const NET_RIGHT_BORDER_X = NET_X + NET_WIDTH - NET_HEIGHT / 2;
const NET_RIGHT_BORDER_Y = NET_LEFT_BORDER_Y;

// ball lifecycle
const LC_WAITING = 0;
const LC_STARTING = 1;
const LC_FALLING = 2;
const LC_BOUNCING = 3;
const LC_RESTARTING = 4;
const LC_RESTARTING_FALLING = 5;
const reporter = (error) => {
  // Logic for reporting to devs
  // Example : Log issues to github issues using github apis.
  console.log(error); // sample
};

const errorHandler = (e, isFatal) => {
  if (isFatal) {
    reporter(e);
  } else {
    console.log(e); // So that we can see it in the ADB logs in case of Android if needed
  }
};

setJSExceptionHandler(errorHandler, true);
var CallFlow = require('./callflow');
var Horizon = require("@horizon/client");
var Dbref = require("./dbref");
var jwtDecode = require('jwt-decode');
var uuid = require('node-uuid');

var horizon = Horizon({ authType: 'token', secure: true, host: 'phoneline.prod.loltel.co' });
const authToken = "eyJhbGciOiJIUzUxMiJ9.eyJleHRlcm5hbCI6ZmFsc2UsIm1zaXNkbiI6IjQ2NzI0NDUyMDMwIiwiZXhwIjoxNTE0MTIwMDY1LCJ1c2VySWQiOiJiYmFjZTAyMi1mZTA4LTQzODQtOGZhMC1hN2IyMmM0ZmIyZjMifQ.68JHZzQ8ATgbJhXEj0wXu1-Di1B0qQIHsemM0_tQaSesH4iS_h4qy9Mek--eIhsBXNnX-NPsbYUHNxh8lYXOvg";
horizon.utensils.tokenStorage.set(authToken);

horizon.connect((err) => {
    console.error('Received an error: ', err);
});

function logError(error) {
  console.log("logError", error);
}

let localStream;

function getLocalStream(isFront, callback) {

  let videoSourceId;

  // on android, you don't have to specify sourceId manually, just use facingMode
  // uncomment it if you want to specify
  if (Platform.OS === 'ioszz') {
    MediaStreamTrack.getSources(sourceInfos => {
      console.log("sourceInfos: ", sourceInfos);

      for (const i = 0; i < sourceInfos.length; i++) {
        const sourceInfo = sourceInfos[i];
        if(sourceInfo.kind == "video" && sourceInfo.facing == (isFront ? "front" : "back")) {
          videoSourceId = sourceInfo.id;
        }
      }
    });
  }
    let videoConfig = false;
    if (videoSourceId) {
        videoConfig = {
            mandatory: {
                minWidth: 640, // Provide your own width, height and frame rate here
                minHeight: 360,
                minFrameRate: 30,
            },
            facingMode: (isFront ? "user" : "environment"),
            optional: (videoSourceId ? [{sourceId: videoSourceId}] : []),
        };
    }
  getUserMedia({
    audio: true,
    video: videoConfig
  }, function (stream) {
    console.log('getUserMedia success', stream);
    callback(stream);
  }, logError);
}


let hzAuthData;
horizon.onReady(() =>
                horizon.currentUser()
                .fetch()
                .subscribe((user) => {
                    hzAuthData = jwtDecode(authToken);
                    console.log('Got hz user: ' + user );
                    getLocalStream(true, function(stream) {
                        localStream = stream;
                        container.setState({selfViewSrc: stream.toURL()});
                        container.setState({status: 'ready', info: 'Please enter or create room ID'});
                    });
                    console.log('Have local stream:' + JSON.stringify(user));
                }));
var firebaseRef = new Dbref(horizon, '');
var call;
var LibPhoneNumber = require('google-libphonenumber');

let util = LibPhoneNumber.PhoneNumberUtil.getInstance();
let parseNumber = function(number, countrycode) {
    return new Promise((resolve, reject) => {
        var processed = {
            isPossibleNumber: false,
            regionCode: "NO",
            nationalFormat: number,
            nationalNumber: number,
            internationalFormat: number,
            internationalNumber: number,
            E614: number
        };
        // Ignore phone number without any digits
        if (!number || number.search(/\d/) == -1) {
            return reject("Bad number");
        }
        try {
            var phoneNumber = util.parse(number, countrycode);
            if (!phoneNumber) {
                return reject('Error Parsing '+number);
            }
            var e614 = util.format(phoneNumber, LibPhoneNumber.PhoneNumberFormat.E164);
            processed = {
                isPossibleNumber: util.isPossibleNumber(phoneNumber),
                regionCode: util.getRegionCodeForNumber(phoneNumber),
                nationalFormat: util.format(phoneNumber, LibPhoneNumber.PhoneNumberFormat.NATIONAL),
                nationalNumber: util.getNationalSignificantNumber(phoneNumber),
                internationalFormat: util.format(phoneNumber, LibPhoneNumber.PhoneNumberFormat.INTERNATIONAL),
                internationalNumber: e614,
                E614: e614
            };
            resolve(processed);
        }
        catch(err) {
            reject('Error Parsing '+number+' '+err);
            return;
        }
    });
}

function join(number, container) {
    parseNumber(number, 'NO')
        .then((parsed)=>makeCall(parsed.internationalNumber, container))
        .catch((err)=>{ console.log(err);
                        container.setState({status: 'ready', info: err});
                      });
}

function makeCall(number, container) {
    console.log('call', number);

    var userid = hzAuthData.userId;
    var msisdn = hzAuthData.msisdn;
    var callRef = firebaseRef.child('call').push();
    var callLogRef = firebaseRef.child('recentcalls/' + userid + '/' + callRef.key);
    var config = {
        firebaseRef: firebaseRef,
        callRef: callRef,
        callLogRef: callLogRef,
        remoteMsisdn: number,
        localMsisdn: msisdn,
        localStream: localStream,
        terminalId: uuid.v4()
    };
    call = new CallFlow(config);
    call.on('stateChange', (obj, state)=> { if (state) container.setPhoneState(state) } );
    call.makeCall();
}


class Basketball extends Component {

  constructor(props) {
    super(props);

    this.interval = null;

    // initialize ball states
    this.state = {
      x: Dimensions.get('window').width / 2 - radius,
      y: FLOOR_Y,
      vx: 0,
      vy: 0,
      rotate: 0,
      scale: 1,
      lifecycle: LC_WAITING,
      scored: null,
      score: 0,
      phone: 'idle'
    };
  }

  componentDidMount() {
    this.interval = setInterval(this.update.bind(this), 1000 / 60);
  }

  componentWillUnmount() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  onStart(angle) {
    if (this.state.lifecycle === LC_WAITING) {
      this.setState({
        vx: angle * 0.2,
        vy: -16,
        lifecycle: LC_STARTING,
      });
    }
  }
    
    onClick() {
        if (this.state.phone != 'idle' && this.state.phone != 'ended') {
            this.endCall();
            return;
        }
        this.callContact();
    }
    
    endCall(event) {
        if (call) {
            call.endCall();
        }
        this.setPhoneState('idle');
        
    }

  callContact() {
        ContactsWrapper.getContact()
        .then((contact) => {
            // Replace this code
            console.log(contact);
            // this.setState(contact.phone);
            this.setPhoneState('incall');
            join(contact.phone, this);
        })
        .catch((error) => {
            console.log("ERROR CODE: ", error.code);
            console.log("ERROR MESSAGE: ", error.message);
            this.endCall();
        });
  }

  randomIntFromInterval(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  circlesColliding(circle1, circle2) {
    const dx = circle1.x - circle2.x;
    const dy = circle1.y - circle2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < circle1.radius + circle2.radius) {
      return true;
    }
    return false;
  }

  // Inspired by http://www.adambrookesprojects.co.uk/project/canvas-collision-elastic-collision-tutorial/
  updateCollisionVelocity(nextState, ball, netBorder) {
    const xDistance = (netBorder.x - ball.x);
    const yDistance = (netBorder.y - ball.y);
    let normalVector = new Vector(xDistance, yDistance);
    normalVector = normalVector.normalise();

    const tangentVector = new Vector((normalVector.getY() * -1), normalVector.getX());

    // create ball scalar normal direction.
    const ballScalarNormal = normalVector.dot(ball.velocity);
    const netScalarNormal = normalVector.dot(netBorder.velocity);

    // create scalar velocity in the tagential direction.
    const ballScalarTangential = tangentVector.dot(ball.velocity);

    const ballScalarNormalAfter = (ballScalarNormal * (ball.mass - netBorder.mass) +
     2 * netBorder.mass * netScalarNormal) / (ball.mass + netBorder.mass);

    const ballScalarNormalAfterVector = normalVector.multiply(ballScalarNormalAfter);
    const ballScalarNormalVector = (tangentVector.multiply(ballScalarTangential));

    const nextVelocity = ballScalarNormalVector.add(ballScalarNormalAfterVector);

    if (ball.y < NET_Y + NET_HEIGHT / 2) {
      nextState.vx = nextVelocity.x;
    } else {
      nextState.vx = -nextVelocity.x;
    }

    nextState.vy = nextVelocity.y;
    nextState.x = this.state.x + nextState.vx;
    nextState.y = this.state.y - nextState.vy;
  }

  handleCollision(nextState) {
    if (nextState.lifecycle !== LC_FALLING && nextState.lifecycle !== LC_BOUNCING) return;

    const _self = this;

    const ball = {
      x: nextState.x + radius,
      y: nextState.y + radius,
      radius: radius * nextState.scale,
      velocity: {
        getX() {
          return _self.state.vx;
        },
        getY() {
          return _self.state.vy;
        },
      },
      mass: 2,
    };
    const netLeftBorder = {
      x: NET_LEFT_BORDER_X,
      y: NET_LEFT_BORDER_Y,
      radius: NET_HEIGHT / 2,
      velocity: {
        getX() {
          return 0;
        },
        getY() {
          return 0;
        },
      },
      mass: 10,
    };
    const netRightBorder = {
      x: NET_RIGHT_BORDER_X,
      y: NET_RIGHT_BORDER_Y,
      radius: NET_HEIGHT / 2,
      velocity: {
        getX() {
          return 0;
        },
        getY() {
          return 0;
        },
      },
      mass: 10,
    };

    const isLeftCollision = this.circlesColliding(ball, netLeftBorder);
    if (isLeftCollision) {
      nextState.lifecycle = LC_BOUNCING;
      this.updateCollisionVelocity(nextState, ball, netLeftBorder);
    } else {
      const isRightCollision = this.circlesColliding(ball, netRightBorder);
      if (isRightCollision) {
        nextState.lifecycle = LC_BOUNCING;
        this.updateCollisionVelocity(nextState, ball, netRightBorder);
      }
    }
  }

  updateVelocity(nextState) {
    nextState.vx = this.state.vx;
    if (nextState.lifecycle === LC_STARTING && nextState.y < NET_Y - 200) {
      nextState.vy = this.state.vy;
    } else {
      nextState.vy = this.state.vy + gravity;
    }
  }

  updatePosition(nextState) {
    nextState.x = this.state.x + nextState.vx;
    nextState.y = this.state.y - nextState.vy;

    if (nextState.lifecycle === LC_STARTING && nextState.y < this.state.y) {
      nextState.lifecycle = LC_FALLING;
    }
    if (nextState.lifecycle === LC_RESTARTING && nextState.y < this.state.y) {
      nextState.lifecycle = LC_RESTARTING_FALLING;
    }

    if (this.state.scored === null) {
      if (this.state.y + radius > NET_Y + NET_HEIGHT / 2 && nextState.y + radius < NET_Y + NET_HEIGHT / 2) {
        if (nextState.x + radius > NET_LEFT_BORDER_X && nextState.x + radius < NET_RIGHT_BORDER_X) {
          nextState.scored = true;
          nextState.score += 1;
        } else {
          nextState.scored = false;
        }
      }
    }
  }

  updateScale(nextState) {
    if (nextState.lifecycle === LC_BOUNCING || nextState.lifecycle === LC_RESTARTING || nextState.lifecycle === LC_RESTARTING_FALLING) return;

    let scale = this.state.scale;
    if (scale > 0.4 && this.state.y > FLOOR_HEIGHT) {
      scale -= 0.01;
    }

    nextState.scale = scale;
  }

  updateRotate(nextState) {
    nextState.rotate = this.state.rotate + (nextState.vx * rotationFactor);
  }

  handleRestart(nextState) {
    if (nextState.lifecycle === LC_RESTARTING_FALLING && nextState.y <= FLOOR_Y) {
      // in front of the Floor
      // will restart to 'Waiting' lifecycle step
      nextState.y = FLOOR_Y;
      nextState.vx = 0;
      nextState.vy = 0;
      nextState.rotate = 0;
      nextState.scale = 1;
      nextState.lifecycle = LC_WAITING;

      nextState.scored = null;
    }

    const outOfScreen = (nextState.x > Dimensions.get('window').width + 100 || nextState.x < 0 - (radius * 2) - 100);

    if (
      (outOfScreen === true)
      || ((nextState.lifecycle === LC_FALLING || nextState.lifecycle === LC_BOUNCING) && (nextState.y + (radius * nextState.scale * 2) < FLOOR_Y + radius * -2))
    ) {
      if (outOfScreen && nextState.scored === null) {
        nextState.scored = false;
      }

      // behind the Floor
      // will be thrown to the front of the floor
      nextState.y = FLOOR_Y;

      if (nextState.scored === true) {
        nextState.x = this.randomIntFromInterval(4, Dimensions.get('window').width - (radius * 2) - 4);
      } else {
        // nextState.x = Dimensions.get('window').width / 2 - radius;
        nextState.x = this.randomIntFromInterval(4, Dimensions.get('window').width - (radius * 2) - 4);
        nextState.score = 0;
      }

      // nextState.x = Dimensions.get('window').width / 2 - radius;
      nextState.vy = -8;
      nextState.vx = 0;
      nextState.scale = 1;
      nextState.rotate = 0;
      nextState.lifecycle = LC_RESTARTING;
    }
  }

    setPhoneState(s) {
        nextState = Object.assign({}, this.state);
        nextState.phone = s;
        console.log('changed state to', s);
        this.setState(nextState);
    }
    
  update() {
    if (this.state.lifecycle === LC_WAITING) return;

    let nextState = null;
    nextState = Object.assign({}, this.state);
    this.updateVelocity(nextState);
    this.updatePosition(nextState);
    this.updateScale(nextState);
    this.updateRotate(nextState);

    this.handleCollision(nextState);
    this.handleRestart(nextState);

    this.setState(nextState);
  }

  renderNet(render) {
    if (render === true) {
      return (
        <Net y={NET_Y} x={NET_X} height={NET_HEIGHT} width={NET_WIDTH} />
      );
    }
    return null;
  }

  renderFloor(render) {
    if (this.state.lifecycle === LC_RESTARTING || this.state.lifecycle === LC_RESTARTING_FALLING) {
      render = !render;
    }

    if (render === true) {
      return (
        <Floor height={FLOOR_HEIGHT} />
      );
    }
    return null;
  }

  render() {
    return (
      <View style={styles.container}>
        <Score y={FLOOR_HEIGHT * 3} score={this.state.score} scored={this.state.scored} phone={this.state.phone} />
        <Hoop y={HOOP_Y} />
        {this.renderNet(this.state.lifecycle === LC_STARTING)}
        {this.renderFloor(this.state.vy <= 0)}
        <Ball
          onStart={this.onStart.bind(this)}
          onClick={this.onClick.bind(this)}
          x={this.state.x}
          y={this.state.y}
          radius={radius}
          rotate={this.state.rotate}
          scale={this.state.scale}
        />
        {this.renderNet(this.state.lifecycle !== LC_STARTING)}
        {this.renderFloor(this.state.vy > 0)}
        <Emoji y={NET_Y} scored={this.state.scored} />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default Basketball;
