import React, { Component } from "react";
import PropTypes from "prop-types";

import { UserAgentApplication } from "msal";
import { Modal, notification } from "antd";

import { isIE, requiresInteraction, timer, expiry } from "./utils";

class Authentication extends Component {
  static propTypes = {
    WrappedComponent: PropTypes.any.isRequired,
    landingPage: PropTypes.any.isRequired,
    msalConfig: PropTypes.shape({
      auth: PropTypes.shape({
        clientId: PropTypes.string.isRequired
      }),
      cache: PropTypes.object,
      system: PropTypes.object
    }).isRequired,
    scopes: PropTypes.arrayOf(PropTypes.string),
    onAuthSuccess: PropTypes.func.isRequired,
    onAuthError: PropTypes.func.isRequired,
    refreshAccess: PropTypes.func,
    tokenCheckFrequency: PropTypes.number
  };

  static defaultProps = {
    scopes: ["user.read"],
    tokenCheckFrequency: 2.5
  };

  constructor(props) {
    super(props);

    this.msalInstance = new UserAgentApplication({
      cache: {
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: isIE()
      },
      auth: {
        ...props.msalConfig.auth,
        navigateToLoginRequestUrl: false,
        validateAuthority: true
      }
    });

    this.state = {};
  }

  componentDidMount() {
    const { onAuthError } = this.props;

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

    this.msalInstance.handleRedirectCallback(error => {
      if (error) onAuthError(error);
    });

    const account = this.msalInstance.getAccount();

    if (account && !(hasAccessToken || hasRefreshToken))
      this.getApplicationTokens();

    this.setState({
      authenticated: hasAccessToken || hasRefreshToken
    });
  }

  handleLogin = async () => {
    const { scopes, onAuthError } = this.props;

    this.setState({ error: null });

    if (isIE()) {
      return this.msalInstance.loginRedirect({
        scopes,
        prompt: "select_account"
      });
    }

    const loginResponse = await this.msalInstance
      .loginPopup({
        scopes,
        prompt: "select_account"
      })
      .catch(error => {
        this.setState({
          loading: false,
          error: onAuthError(error),
          expiryWarningVisible: false
        });
      });

    if (loginResponse) this.getApplicationTokens();
  };

  getApplicationTokens = async () => {
    const { onAuthSuccess } = this.props;
    const { expiryWarningVisible } = this.state;

    this.setState({ loading: true });
    const response = await this.getAzureToken();

    const { idToken: azureIdToken, accessToken: azureAccessToken } = response;

    const data = await onAuthSuccess(azureIdToken.rawIdToken, azureAccessToken);
    const { accessToken, refreshToken, extras } = data;

    if (refreshToken) {
      sessionStorage.setItem("refresh", refreshToken);
      sessionStorage.setItem("access", accessToken);
      this.checkRefreshTokenExpiry();
    } else if (accessToken) {
      sessionStorage.setItem("access", accessToken);
      this.checkAccessTokenExpiry();
    }

    if (expiryWarningVisible)
      notification["success"]({
        message: "Your session has been extended"
      });

    this.setState({
      loading: false,
      authenticated: true,
      extras,
      expiryWarningVisible: false
    });
  };

  handleLogout = () => {
    sessionStorage.clear();
    this.msalInstance.logout();
  };

  handleTokenExpiry = () => {
    sessionStorage.clear();
    clearInterval(this.expiryCountdown);
    clearInterval(this.tokenExpiry);
    this.setState({ authenticated: false });
  };

  throwTokenError = () => {
    this.handleTokenExpiry();
    if (!this.state.expiryWarningVisible) {
      this.setState({ expiryWarningVisible: true });
      Modal.confirm({
        icon: "warning",
        title: "Your session has expired",
        content: "Please log in again to continue.",
        cancelButtonProps: { style: { display: "none" } },
        onOk: () => this.setState({ expiryWarningVisible: false })
      });
    }
  };

  getAzureToken = async () => {
    const { scopes } = this.props;

    return this.msalInstance.acquireTokenSilent({ scopes }).catch(error => {
      if (requiresInteraction(error.errorCode)) {
        return isIE()
          ? this.msalInstance.acquireTokenRedirect({
              scopes,
              prompt: "select_account"
            })
          : this.msalInstance.acquireTokenPopup({
              scopes,
              prompt: "select_account"
            });
      }
    });
  };

  refreshAccessToken = async () => {
    const { refreshAccess } = this.props;

    const accessToken = await refreshAccess(
      sessionStorage.getItem("refresh")
    ).catch(() => {
      this.throwTokenError();
    });

    sessionStorage.setItem("access", accessToken);
    return accessToken;
  };

  checkRefreshTokenExpiry = () => {
    const { refreshAccess, tokenCheckFrequency } = this.props;

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
        this.throwTokenError();
      }
    }, tokenCheckFrequency * 60 * 1000); // Check every N minutes
  };

  checkAccessTokenExpiry = () => {
    const { tokenCheckFrequency } = this.props;

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
        this.throwTokenError();
      }
    }, tokenCheckFrequency * 60 * 1000); // Check every N minutes
  };

  render() {
    const { WrappedComponent, landingPage } = this.props;
    const { authenticated, loading, error, extras } = this.state;

    if (authenticated)
      return (
        <WrappedComponent
          getAzureToken={this.getAzureToken}
          isTokenExpired={() => ({
            access: expiry("access") > 0,
            refresh: expiry("refresh") > 0
          })}
          refreshAccessToken={this.refreshAccessToken}
          throwTokenError={this.throwTokenError}
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
