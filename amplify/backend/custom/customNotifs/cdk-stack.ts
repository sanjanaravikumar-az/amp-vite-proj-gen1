import * as mycdkstack from 'aws-cdk-lib';
import * as AmplifyHelpers from '@aws-amplify/cli-extensibility-helper';
import { AmplifyDependentResourcesAttributes } from '../../types/amplify-dependent-resources-ref';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';

export class cdkStack extends mycdkstack.Stack {
  constructor(scope: Construct, id: string, props?: mycdkstack.StackProps, ampprops?: AmplifyHelpers.AmplifyResourceProps) {
    super(scope, id, props);
    const cat = ampprops.category;

    new mycdkstack.CfnParameter(this, 'env', {
      type: 'String',
      description: 'Current Amplify CLI env name',
    });

    const amplifyProjectInfo = AmplifyHelpers.getProjectInfo();
    
    // SNS Topic
    const topic = new sns.Topic(this, 'NotificationTopic', {
      topicName: `notifications-${amplifyProjectInfo.projectName}-${mycdkstack.Fn.ref('env')}`
    });

    // Publisher Lambda
    const publisher = new lambda.Function(this, 'Publisher', {
      functionName: `publisher-${amplifyProjectInfo.projectName}-${mycdkstack.Fn.ref('env')}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { PublishCommand, SNSClient } = require('@aws-sdk/client-sns');
const client = new SNSClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const { subject, body, recipient } = event;
  const command = new PublishCommand({
    TopicArn: process.env.SNS_TOPIC_ARN,
    Message: JSON.stringify({ subject, body, recipient })
  });
  try {
    const response = await client.send(command);
    console.log('published', response);
  } catch (error) {
    console.log('failed to publish message', error);
    throw new Error('Failed to publish message', { cause: error });
  }
};
      `),
      environment: {
        SNS_TOPIC_ARN: topic.topicArn
      }
    });

    // Emailer Lambda
    const emailer = new lambda.Function(this, 'Emailer', {
      functionName: `emailer-${amplifyProjectInfo.projectName}-${mycdkstack.Fn.ref('env')}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const sesClient = new SESClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    await sendEmail(message);
  }
};

const sendEmail = async (message) => {
  const { recipient, subject, body } = message;
  const command = new SendEmailCommand({
    Source: process.env.SOURCE_ADDRESS,
    Destination: { ToAddresses: [recipient] },
    Message: {
      Body: { Text: { Data: body } },
      Subject: { Data: subject }
    }
  });
  try {
    const result = await sesClient.send(command);
    console.log(\`Email sent to \${recipient}: \${result.MessageId}\`);
  } catch (error) {
    console.error(\`Error sending email to \${recipient}: \${error}\`);
    throw new Error(\`Failed to send email to \${recipient}\`, { cause: error });
  }
};
      `),
      environment: {
        SOURCE_ADDRESS: 'your-verified-email@example.com' // Replace with your verified SES email
      }
    });

    // Subscribe emailer to SNS topic
    topic.addSubscription(new subs.LambdaSubscription(emailer));

    // Grant permissions
    topic.grantPublish(publisher);
    
    emailer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*']
    }));

    // Outputs
    new mycdkstack.CfnOutput(this, 'snsTopicArn', {
      value: topic.topicArn,
      description: 'SNS Topic ARN for notifications'
    });

    new mycdkstack.CfnOutput(this, 'publisherFunctionName', {
      value: publisher.functionName,
      description: 'Publisher Lambda function name'
    });

    new mycdkstack.CfnOutput(this, 'emailerFunctionName', {
      value: emailer.functionName,
      description: 'Emailer Lambda function name'
    });
  }
}
