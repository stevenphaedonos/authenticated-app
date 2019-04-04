import React, { Component } from "react";
import * as Msal from "msal";
import PropTypes from "prop-types";
import { Modal } from "antd";

const expiry = token => {
  token = sessionStorage.getItem(token);
  if (!token) return 0;

  const expiresAt = new Date(
    JSON.parse(window.atob(token.split(".")[1])).exp * 1000
  );
  const currentTime = new Date();

  return (expiresAt.getTime() - currentTime.getTime()) / 1000; // Seconds to expiry
};

const timer = token => {
  const secondsToExpiry = expiry(token);
  const roundedMinutes = Math.max(Math.floor(secondsToExpiry / 60), 0);
  return [
    roundedMinutes, // Rounded minutes to expiry
    Math.trunc(secondsToExpiry - roundedMinutes * 60) // Remaining seconds
  ];
};

class Authentication extends Component {
  static propTypes = {
    WrappedComponent: PropTypes.any.isRequired,
    landingPage: PropTypes.any.isRequired,
    msalConfig: PropTypes.shape({
      clientId: PropTypes.string.isRequired,
      authority: PropTypes.string.isRequired,
      redirectUri: PropTypes.string.isRequired,
      storeAuthStateInCookie: PropTypes.bool
    }).isRequired,
    scopes: PropTypes.arrayOf(PropTypes.string),
    authCallback: PropTypes.func,
    refreshAccess: PropTypes.func
  };

  static defaultProps = {
    authCallback: () => {},
    scopes: ["https://graph.microsoft.com/user.read"]
  };

  componentWillMount() {
    const {
      clientId,
      authority,
      redirectUri,
      storeAuthStateInCookie
    } = this.props.msalConfig;

    const hasAccessToken = expiry("access") > 0;
    const hasRefreshToken = expiry("refresh") > 0;

    if (hasAccessToken && hasRefreshToken) {
      this.checkRefreshTokenExpiry();
    } else if (hasRefreshToken) {
      this.refreshAccessToken();
      this.checkRefreshTokenExpiry();
    } else if (hasAccessToken) {
      this.checkAccessTokenExpiry();
    }

    this.setState({
      authenticated: hasAccessToken || hasRefreshToken,
      userAgentApplication: new Msal.UserAgentApplication(
        clientId,
        authority,
        this.tokenReceivedCallback,
        {
          redirectUri: redirectUri,
          postLogoutRedirectUri: redirectUri,
          cacheLocation: "sessionStorage",
          storeAuthStateInCookie: storeAuthStateInCookie || true
        }
      )
    });
  }

  handleLogin = () => {
    const { msalConfig } = this.props;
    const { userAgentApplication } = this.state;

    userAgentApplication.loginRedirect(msalConfig.scopes);
  };

  handleLogout = () => {
    const { userAgentApplication } = this.state;
    sessionStorage.clear();
    userAgentApplication.logout();
  };

  handleTokenExpiry = () => {
    sessionStorage.clear();
    clearInterval(this.expiryCountdown);
    clearInterval(this.tokenExpiry);
    this.setState({ authenticated: false });
  };

  getAzureToken = () => {
    const { scopes } = this.props;
    const userAgentApplication = window.msal;
    return userAgentApplication.acquireTokenSilent(scopes);
  };

  refreshAccessToken = () => {
    const { refreshAccess } = this.props;

    refreshAccess(sessionStorage.getItem("refresh")).then(accessToken =>
      sessionStorage.setItem("access", accessToken)
    );
  };

  tokenReceivedCallback = (error, azureIdToken) => {
    const { authCallback } = this.props;

    this.setState({ loading: true });

    this.getAzureToken().then(azureAccessToken => {
      authCallback(azureIdToken, azureAccessToken)
        .then(data => {
          const { accessToken, refreshToken, extras } = data;

          if (refreshToken) {
            sessionStorage.setItem("refresh", refreshToken);
            sessionStorage.setItem("access", accessToken);
            this.checkRefreshTokenExpiry();
          } else if (accessToken) {
            sessionStorage.setItem("access", accessToken);
            this.checkAccessTokenExpiry();
          }

          this.setState({ loading: false, authenticated: true, extras });
        })
        .catch(err => {
          console.log(err);
          this.setState({ loading: false, error: true });
        });
    });
  };

  checkRefreshTokenExpiry = () => {
    const { refreshAccess } = this.props;

    if (!refreshAccess)
      throw new Error(
        "If refresh tokens are being used, then a function must be provided to perform token refreshes"
      );

    this.tokenExpiry = setInterval(() => {
      const secondsToAccessExpiry = expiry("access");
      // 5 minute threshold
      if (secondsToAccessExpiry < 5 * 60) this.refreshAccessToken();

      const secondsToRefreshExpiry = expiry("refresh");
      if (
        secondsToRefreshExpiry > 0 &&
        secondsToRefreshExpiry < 5 * 60 && // 5 minute threshold
        !this.state.expiryWarningVisible
      ) {
        let [minutes, seconds] = timer("refresh");

        this.setState({ expiryWarningVisible: true });
        const expiryWarningModal = Modal.confirm({
          title: "Timeout warning",
          icon: "warning",
          content: `You will be logged out in ${minutes} minutes
              and ${seconds} seconds. Press OK to extend your session.`,
          onOk: () => {
            this.setState({ expiryWarningVisible: false });
            this.handleLogin();
          },
          onCancel: () => {
            this.setState({ expiryWarningVisible: false });
            clearInterval(this.expiryCountdown);
          }
        });

        this.expiryCountdown = setInterval(() => {
          [minutes, seconds] = timer("refresh");

          if (minutes === 0 && seconds <= 0) {
            this.handleTokenExpiry();
            expiryWarningModal.update({
              title: "Your session has expired",
              content: "Please log in again to continue.",
              cancelButtonProps: { style: { display: "none" } }
            });
          } else {
            expiryWarningModal.update({
              content: `You will be logged out in ${minutes} minutes
                  and ${seconds} seconds. Press OK to extend your session.`
            });
          }
        }, 1000); // Update the countdown every 1 second
      } else if (
        secondsToRefreshExpiry <= 0 &&
        !this.state.expiryWarningVisible
      ) {
        if (!this.state.timeoutWarningVisible) {
          this.setState({ timeoutWarningVisible: true });
          this.handleTokenExpiry();
          Modal.confirm({
            icon: "warning",
            title: "Your session has expired",
            content: "Please log in again to continue.",
            cancelButtonProps: { style: { display: "none" } },
            onOk: () => this.setState({ timeoutWarningVisible: false })
          });
        }
      }
    }, 2.5 * 60 * 1000); // Check every 2.5 minutes
  };

  checkAccessTokenExpiry = () => {
    this.tokenExpiry = setInterval(() => {
      const secondsToExpiry = expiry("access");

      if (
        secondsToExpiry > 0 &&
        secondsToExpiry < 5 * 60 && // 5 minute threshold
        !this.state.expiryWarningVisible
      ) {
        let [minutes, seconds] = timer("access");

        this.setState({ expiryWarningVisible: true });
        const expiryWarningModal = Modal.confirm({
          title: "Your session will expire soon",
          icon: "warning",
          content: `You will be logged out in ${minutes} minutes
              and ${seconds} seconds.`,
          cancelButtonProps: { style: { display: "none" } },
          onOk: () => {
            this.setState({ expiryWarningVisible: false });
            clearInterval(this.expiryCountdown);
          }
        });

        this.expiryCountdown = setInterval(() => {
          [minutes, seconds] = timer("access");

          if (minutes === 0 && seconds <= 0) {
            this.handleTokenExpiry();
            expiryWarningModal.update({
              title: "Your session has expired",
              content: "Please log in again to continue."
            });
          } else {
            expiryWarningModal.update({
              content: `You will be logged out in ${minutes} minutes
                  and ${seconds} seconds.`
            });
          }
        }, 1000); // Update the countdown every 1 second
      } else if (secondsToExpiry <= 0 && !this.state.expiryWarningVisible) {
        if (!this.state.timeoutWarningVisible) {
          this.setState({ timeoutWarningVisible: true });
          this.handleTokenExpiry();
          Modal.confirm({
            icon: "warning",
            title: "Your session has expired",
            content: "Please log in again to continue.",
            cancelButtonProps: { style: { display: "none" } },
            onOk: () => this.setState({ timeoutWarningVisible: false })
          });
        }
      }
    }, 2.5 * 60 * 1000); // Check every 2.5 minutes
  };

  render() {
    const { WrappedComponent, landingPage } = this.props;
    const { authenticated, loading, error, extras } = this.state;

    if (authenticated)
      return (
        <WrappedComponent
          getAzureToken={this.getAzureToken}
          logout={this.handleLogout}
          {...extras}
        />
      );

    return React.cloneElement(landingPage, {
      handleLogin: this.handleLogin,
      loading,
      error
    });
  }
}

export const authenticatedApplication = config => WrappedComponent => {
  return () => (
    <Authentication {...config} WrappedComponent={WrappedComponent} />
  );
};
