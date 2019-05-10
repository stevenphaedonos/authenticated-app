import React, { Component } from "react";
import * as Msal from "msal";
import PropTypes from "prop-types";
import { Modal, notification } from "antd";

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

  componentWillMount() {
    const { msalConfig } = this.props;

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

    const msalInstance = new Msal.UserAgentApplication({
      cache: { cacheLocation: "sessionStorage" },
      ...msalConfig
    });

    this.setState({
      authenticated: hasAccessToken || hasRefreshToken,
      userAgentApplication: msalInstance
    });
  }

  handleLogin = async () => {
    const { scopes, onAuthSuccess, onAuthError } = this.props;
    const { userAgentApplication, expiryWarningVisible } = this.state;

    this.setState({ error: null });

    try {
      await userAgentApplication.loginPopup({
        scopes,
        prompt: "select_account"
      });

      this.setState({ loading: true });
      const response = await this.getAzureToken();
      const { idToken: azureIdToken, accessToken: azureAccessToken } = response;

      const data = await onAuthSuccess(
        azureIdToken.rawIdToken,
        azureAccessToken
      );
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
        })

      this.setState({
        loading: false,
        authenticated: true,
        extras,
        expiryWarningVisible: false
      });
    } catch (error) {
      this.setState({
        loading: false,
        error: onAuthError(error),
        expiryWarningVisible: false
      });
    }
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
    const { userAgentApplication } = this.state;
    return userAgentApplication.acquireTokenSilent({ scopes });
  };

  refreshAccessToken = async () => {
    const { refreshAccess } = this.props;

    try {
      const accessToken = await refreshAccess(
        sessionStorage.getItem("refresh")
      );
      sessionStorage.setItem("access", accessToken);
    } catch {
      this.handleTokenExpiry();
      Modal.confirm({
        icon: "warning",
        title: "Your session has expired",
        content: "Please log in again to continue.",
        cancelButtonProps: { style: { display: "none" } }
      });
    }
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
    }, tokenCheckFrequency * 60 * 1000); // Check every N minutes
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
