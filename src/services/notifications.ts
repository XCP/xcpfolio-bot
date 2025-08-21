/**
 * Notification service for Discord/Slack webhooks
 * Handles all external notifications
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'critical';

export class NotificationService {
  private static discordWebhook = process.env.DISCORD_WEBHOOK_URL;
  private static slackWebhook = process.env.SLACK_WEBHOOK_URL;
  
  /**
   * Send notification to configured webhooks
   */
  static async send(
    message: string, 
    level: NotificationLevel = 'info',
    details?: Record<string, any>
  ): Promise<void> {
    // Always log to console
    const emoji = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      critical: '🚨'
    }[level];
    
    console.log(`${emoji} [${level.toUpperCase()}] ${message}`);
    if (details) {
      console.log('Details:', details);
    }
    
    // Send to Discord
    if (this.discordWebhook) {
      await this.sendToDiscord(message, level, details);
    }
    
    // Send to Slack
    if (this.slackWebhook) {
      await this.sendToSlack(message, level, details);
    }
  }
  
  private static async sendToDiscord(
    message: string,
    level: NotificationLevel,
    details?: Record<string, any>
  ): Promise<void> {
    try {
      const color = {
        info: 0x3498db,     // Blue
        success: 0x2ecc71,  // Green
        warning: 0xf39c12,  // Orange
        error: 0xe74c3c,    // Red
        critical: 0x9b59b6  // Purple
      }[level];
      
      const embed: any = {
        title: level === 'critical' ? '🚨 CRITICAL ALERT' : `${level.toUpperCase()}`,
        description: message,
        color,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'XCPFOLIO Bot'
        }
      };
      
      // Add fields for details
      if (details) {
        embed.fields = Object.entries(details).map(([key, value]) => ({
          name: key,
          value: String(value).slice(0, 1024),
          inline: true
        }));
      }
      
      await fetch(this.discordWebhook!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'XCPFOLIO Bot',
          embeds: [embed]
        })
      });
    } catch (error) {
      console.error('Failed to send Discord notification:', error);
    }
  }
  
  private static async sendToSlack(
    message: string,
    level: NotificationLevel,
    details?: Record<string, any>
  ): Promise<void> {
    try {
      const emoji = {
        info: ':information_source:',
        success: ':white_check_mark:',
        warning: ':warning:',
        error: ':x:',
        critical: ':rotating_light:'
      }[level];
      
      let text = `${emoji} *${level.toUpperCase()}*: ${message}`;
      
      if (details) {
        text += '\n```' + JSON.stringify(details, null, 2) + '```';
      }
      
      await fetch(this.slackWebhook!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
    } catch (error) {
      console.error('Failed to send Slack notification:', error);
    }
  }
  
  // Convenience methods
  static info(message: string, details?: Record<string, any>) {
    return this.send(message, 'info', details);
  }
  
  static success(message: string, details?: Record<string, any>) {
    return this.send(message, 'success', details);
  }
  
  static warning(message: string, details?: Record<string, any>) {
    return this.send(message, 'warning', details);
  }
  
  static error(message: string, details?: Record<string, any>) {
    return this.send(message, 'error', details);
  }
  
  static critical(message: string, details?: Record<string, any>) {
    return this.send(message, 'critical', details);
  }
}